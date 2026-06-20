#!/usr/bin/env python3
import base64
import hashlib
import hmac
import ipaddress
import json
import os
import re
import shutil
import subprocess
import time
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import urlopen


APP_DIR = Path(os.environ.get("PORT_GUARD_HOME", "/opt/port-guard-ui"))
STATIC_DIR = APP_DIR / "static"
CONFIG_DIR = Path(os.environ.get("PORT_GUARD_CONFIG_DIR", "/etc/port-guard-ui"))
CONFIG_FILE = CONFIG_DIR / "config.json"
AUTH_FILE = CONFIG_DIR / "auth.json"
BACKUP_DIR = Path(os.environ.get("PORT_GUARD_BACKUP_DIR", "/var/backups/port-guard-ui"))
TOKEN = os.environ.get("PORT_GUARD_TOKEN", "")
SECRET = os.environ.get("PORT_GUARD_SECRET") or base64.urlsafe_b64encode(os.urandom(32)).decode("ascii")
DEFAULT_PASSWORD = os.environ.get("PORT_GUARD_DEFAULT_PASSWORD", "admin")
BIND = os.environ.get("PORT_GUARD_BIND", "0.0.0.0")
PORT = int(os.environ.get("PORT_GUARD_PORT", "8787"))
INIT_OPEN_LISTENING = os.environ.get("PORT_GUARD_INIT_OPEN_LISTENING", "0").strip().lower() in {"1", "true", "yes", "on"}

CHAIN_INPUT = "PORTGUARD-INPUT"
CHAIN_DOCKER = "PORTGUARD-DOCKER"
MODES = {"open", "whitelist", "block_cn", "blacklist", "closed"}
SCOPES = {"input", "docker", "both"}
PROTOCOLS = {"tcp", "udp"}
IPSET_NAME_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")
BACKUP_NAME_RE = re.compile(r"^iptables-(?:before-open-all-)?[0-9TZ]+\.rules$")
REQUIRED_GROUP_ID = "internal"
TEMP_OPEN_COMMENT = "PORTGUARD_TEMP_OPEN_ALL"
SAFE_INPUT_PORTS_RAW = os.environ.get("PORT_GUARD_SAFE_INPUT_PORTS", "22222")
AUTH_ITERATIONS = 260_000
LOGIN_WINDOW_SECONDS = 60
LOGIN_MAX_FAILURES = 5
LOGIN_FAILURES = {}
DEFAULT_SOURCE_GROUPS = [
    {
        "id": "internal",
        "name": "内网 IP",
        "protected": True,
        "sources": ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
    },
    {
        "id": "personal",
        "name": "个人 IP",
        "protected": False,
        "sources": [],
    },
    {
        "id": "trusted",
        "name": "可信来源",
        "protected": False,
        "sources": [],
    },
]


DEFAULT_CONFIG = {
    "schema": 1,
    "cn_set": "cnblock",
    "persist": True,
    "drop_cn_fallback": False,
    "block_cn_all_ports": False,
    "source_groups": DEFAULT_SOURCE_GROUPS,
    "rules": []
}


class AppError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def run(cmd, check=True, input_data=None):
    proc = subprocess.run(
        cmd,
        input=input_data,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    out = proc.stdout.decode("utf-8", "replace")
    err = proc.stderr.decode("utf-8", "replace")
    if check and proc.returncode != 0:
        raise AppError(f"{' '.join(cmd)} failed: {err.strip() or out.strip()}", 500)
    return proc.returncode, out, err


def ensure_dirs():
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    ensure_auth_file()
    if not CONFIG_FILE.exists():
        config = initial_open_listening_config() if INIT_OPEN_LISTENING else DEFAULT_CONFIG
        if INIT_OPEN_LISTENING:
            apply_firewall(config, create_backup=False)
        else:
            write_json(CONFIG_FILE, config)


def read_json(path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        if default is not None:
            return default
        raise


def write_json(path, data):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def password_hash(password):
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", str(password).encode("utf-8"), salt, AUTH_ITERATIONS)
    return {
        "scheme": "pbkdf2_sha256",
        "iterations": AUTH_ITERATIONS,
        "salt": base64.b64encode(salt).decode("ascii"),
        "hash": base64.b64encode(digest).decode("ascii"),
    }


def verify_password(password, record):
    try:
        if record.get("scheme") != "pbkdf2_sha256":
            return False
        iterations = int(record.get("iterations", 0))
        salt = base64.b64decode(record.get("salt", ""))
        expected = base64.b64decode(record.get("hash", ""))
        actual = hashlib.pbkdf2_hmac("sha256", str(password).encode("utf-8"), salt, iterations)
        return hmac.compare_digest(actual, expected)
    except Exception:
        return False


def write_auth_password(password):
    write_json(AUTH_FILE, {"schema": 1, "password": password_hash(password), "updated_at": int(time.time())})
    try:
        AUTH_FILE.chmod(0o600)
    except OSError:
        pass


def ensure_auth_file():
    if not AUTH_FILE.exists():
        write_auth_password(DEFAULT_PASSWORD)


def verify_login_password(password):
    auth = read_json(AUTH_FILE, {})
    if verify_password(password, auth.get("password", {})):
        return True
    return bool(TOKEN and hmac.compare_digest(str(password), TOKEN))


def change_login_password(current_password, new_password):
    if not verify_login_password(current_password):
        raise AppError("当前密码不正确", 401)
    new_password = str(new_password or "")
    if len(new_password) < 4:
        raise AppError("新密码至少需要 4 个字符")
    if len(new_password) > 256:
        raise AppError("新密码过长")
    write_auth_password(new_password)
    return {"changed": True}


def is_loopback_bind(host):
    value = str(host or "").strip().lower()
    return value in {"localhost", "::1"} or value.startswith("127.")


def now_stamp():
    return time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())


def sign_session(expiry):
    payload = str(expiry).encode()
    sig = hmac.new(SECRET.encode(), payload, hashlib.sha256).hexdigest()
    raw = payload + b"." + sig.encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def verify_session(value):
    try:
        raw = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
        payload, sig = raw.rsplit(b".", 1)
        expected = hmac.new(SECRET.encode(), payload, hashlib.sha256).hexdigest().encode()
        if not hmac.compare_digest(sig, expected):
            return False
        return int(payload.decode()) >= int(time.time())
    except Exception:
        return False


def parse_cookie(header):
    if not header:
        return {}
    cookie = SimpleCookie()
    cookie.load(header)
    return {k: v.value for k, v in cookie.items()}


def json_body(handler):
    length = int(handler.headers.get("Content-Length", "0"))
    if length > 512 * 1024:
        raise AppError("request body too large", 413)
    raw = handler.rfile.read(length)
    if not raw:
        return {}
    try:
        return json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise AppError(f"invalid JSON: {exc}", 400)


def login_lock_seconds(ip):
    now = time.time()
    attempts = [item for item in LOGIN_FAILURES.get(ip, []) if now - item < LOGIN_WINDOW_SECONDS]
    LOGIN_FAILURES[ip] = attempts
    if len(attempts) >= LOGIN_MAX_FAILURES:
        return max(1, int(LOGIN_WINDOW_SECONDS - (now - attempts[0])))
    return 0


def record_login_failure(ip):
    now = time.time()
    attempts = [item for item in LOGIN_FAILURES.get(ip, []) if now - item < LOGIN_WINDOW_SECONDS]
    attempts.append(now)
    LOGIN_FAILURES[ip] = attempts


def clear_login_failures(ip):
    LOGIN_FAILURES.pop(ip, None)


def validate_ipset_name(name):
    if not isinstance(name, str) or not IPSET_NAME_RE.match(name):
        raise AppError(f"invalid ipset name: {name!r}")
    return name


def normalize_sources(values, field):
    if values is None:
        return []
    if not isinstance(values, list):
        raise AppError(f"{field} must be a list")
    result = []
    for item in values:
        value = str(item).strip()
        if not value:
            continue
        try:
            network = ipaddress.ip_network(value, strict=False)
        except ValueError as exc:
            raise AppError(f"invalid {field} entry {value!r}: {exc}") from exc
        if network.version != 4:
            raise AppError(f"IPv6 is not managed by this panel: {value}")
        result.append(str(network))
    return sorted(set(result), key=lambda x: (ipaddress.ip_network(x, strict=False).network_address, x))


def normalize_ports(values, field):
    if values is None:
        return []
    if not isinstance(values, list):
        raise AppError(f"{field} must be a list")
    result = []
    for item in values:
        try:
            port = int(item)
        except (TypeError, ValueError):
            raise AppError(f"invalid {field} port: {item!r}")
        if port < 1 or port > 65535:
            raise AppError(f"{field} port out of range: {port}")
        result.append(port)
    return sorted(set(result))


def safe_input_ports():
    if not SAFE_INPUT_PORTS_RAW.strip():
        return []
    return normalize_ports(re.split(r"[\s,，]+", SAFE_INPUT_PORTS_RAW.strip()), "safe_input_ports")


def normalize_group_id(value, index, seen):
    group_id = str(value or "").strip()
    group_id = re.sub(r"[^A-Za-z0-9_.:-]", "-", group_id)[:80] or f"group-{index + 1}"
    if group_id in seen:
        group_id = f"{group_id}-{index + 1}"
    seen.add(group_id)
    return group_id


def append_unique_sources(target, sources):
    seen = set(target)
    for source in sources:
        if source not in seen:
            seen.add(source)
            target.append(source)


def migrate_source_groups(config):
    raw_groups = config.get("source_groups", [])
    if not isinstance(raw_groups, list):
        raw_groups = []

    groups = []
    seen = set()
    bootstrap_defaults = not raw_groups
    defaults = DEFAULT_SOURCE_GROUPS if bootstrap_defaults else DEFAULT_SOURCE_GROUPS[:1]
    for default in defaults:
        sources = list(default.get("sources", [])) if default["id"] == REQUIRED_GROUP_ID or bootstrap_defaults else []
        groups.append({
            "id": default["id"],
            "name": default["name"],
            "protected": bool(default.get("protected")),
            "sources": sources,
        })
        seen.add(default["id"])

    for idx, group in enumerate(raw_groups):
        if not isinstance(group, dict):
            continue
        group_id = str(group.get("id") or "").strip()
        group_name = str(group.get("name") or "").strip()
        if group_id == "former-global" or group_name.replace(" ", "").lower() in {"车友ip", "车友ip汇集"}:
            group_id = "car-friends"
        if group_id in seen:
            target = next(item for item in groups if item["id"] == group_id)
            if group_id != REQUIRED_GROUP_ID and group.get("name"):
                target["name"] = str(group.get("name")).strip()[:80] or target["name"]
            if group_id == REQUIRED_GROUP_ID:
                append_unique_sources(target["sources"], list(group.get("sources") or []))
            else:
                target["sources"] = list(group.get("sources") or [])
            continue
        group_id = normalize_group_id(group_id, idx + len(groups), seen)
        groups.append({
            "id": group_id,
            "name": str(group.get("name") or f"策略组 {idx + 1}").strip()[:80] or f"策略组 {idx + 1}",
            "protected": False,
            "sources": list(group.get("sources") or []),
        })

    append_unique_sources(groups[0]["sources"], list(config.get("internal_allow") or []))
    if bootstrap_defaults and len(groups) > 1:
        append_unique_sources(groups[1]["sources"], list(config.get("global_allow") or []))
    return groups


def normalize_source_groups(config):
    values = migrate_source_groups(config)
    if not isinstance(values, list):
        raise AppError("source_groups must be a list")
    normalized = []
    seen = set()
    for idx, group in enumerate(values):
        if not isinstance(group, dict):
            raise AppError(f"source group {idx + 1} must be an object")
        group_id = normalize_group_id(group.get("id"), idx, seen)
        protected = bool(group.get("protected")) or group_id == REQUIRED_GROUP_ID
        name = "内网 IP" if group_id == REQUIRED_GROUP_ID else str(group.get("name") or f"策略组 {idx + 1}").strip()[:80] or f"策略组 {idx + 1}"
        normalized.append({
            "id": group_id,
            "name": name,
            "protected": protected,
            "sources": normalize_sources(group.get("sources", []), f"{group_id}.sources"),
        })
    if REQUIRED_GROUP_ID not in {group["id"] for group in normalized}:
        default_internal = DEFAULT_SOURCE_GROUPS[0]
        normalized.insert(0, {
            "id": REQUIRED_GROUP_ID,
            "name": "内网 IP",
            "protected": True,
            "sources": normalize_sources(default_internal["sources"], "internal.sources"),
        })
    return normalized, {group["id"] for group in normalized}


def normalize_source_group_refs(values, group_ids, field):
    if values is None:
        return []
    if not isinstance(values, list):
        raise AppError(f"{field} must be a list")
    result = []
    for item in values:
        group_id = str(item).strip()
        if group_id == "former-global":
            group_id = "car-friends"
        if not group_id:
            continue
        if group_id not in group_ids:
            raise AppError(f"unknown source group for {field}: {group_id}")
        result.append(group_id)
    return sorted(set(result))


def ensure_inline_group(source_groups, group_ids, sources, name):
    normalized_sources = normalize_sources(sources, name)
    if not normalized_sources:
        return None
    base = re.sub(r"[^A-Za-z0-9_.:-]", "-", name.lower())[:48] or "inline"
    group_id = base
    index = 1
    while group_id in group_ids:
        index += 1
        group_id = f"{base}-{index}"
    source_groups.append({
        "id": group_id,
        "name": name,
        "protected": False,
        "sources": normalized_sources,
    })
    group_ids.add(group_id)
    return group_id


def validate_config(config):
    if not isinstance(config, dict):
        raise AppError("config must be an object")
    source_groups, group_ids = normalize_source_groups(config)
    normalized = {
        "schema": 1,
        "cn_set": validate_ipset_name(config.get("cn_set", "cnblock")),
        "persist": bool(config.get("persist", True)),
        "drop_cn_fallback": bool(config.get("drop_cn_fallback", False)),
        "block_cn_all_ports": bool(config.get("block_cn_all_ports", True)),
        "source_groups": source_groups,
        "rules": []
    }
    rules = config.get("rules", [])
    if not isinstance(rules, list):
        raise AppError("rules must be a list")
    seen = set()
    for idx, rule in enumerate(rules):
        if not isinstance(rule, dict):
            raise AppError(f"rule {idx + 1} must be an object")
        rule_id = str(rule.get("id") or f"rule-{idx + 1}").strip()
        rule_id = re.sub(r"[^A-Za-z0-9_.:-]", "-", rule_id)[:80] or f"rule-{idx + 1}"
        if rule_id in seen:
            rule_id = f"{rule_id}-{idx + 1}"
        seen.add(rule_id)
        mode = str(rule.get("mode", "whitelist"))
        if mode == "cf_only":
            mode = "block_cn"
        scope = str(rule.get("scope", "both"))
        if mode not in MODES:
            raise AppError(f"invalid mode for {rule_id}: {mode}")
        if scope not in SCOPES:
            raise AppError(f"invalid scope for {rule_id}: {scope}")
        protocols = rule.get("protocols", ["tcp"])
        if not isinstance(protocols, list):
            raise AppError(f"protocols for {rule_id} must be a list")
        protocols = sorted(set(str(p).lower() for p in protocols if str(p).lower() in PROTOCOLS))
        if not protocols:
            raise AppError(f"{rule_id} must include tcp or udp")
        ports = normalize_ports(rule.get("ports", []), f"{rule_id}.ports")
        if not ports:
            raise AppError(f"{rule_id} must include at least one port")
        docker_ports = normalize_ports(rule.get("docker_ports", []), f"{rule_id}.docker_ports")
        normalized_rule = {
            "id": rule_id,
            "name": str(rule.get("name") or rule_id).strip()[:120],
            "enabled": bool(rule.get("enabled", True)),
            "scope": scope,
            "protocols": protocols,
            "ports": ports,
            "docker_ports": docker_ports,
            "mode": mode,
            "source_groups": normalize_source_group_refs(rule.get("source_groups", []), group_ids, f"{rule_id}.source_groups"),
            "blacklist_enabled": bool(rule.get("blacklist_enabled", False)),
            "blacklist_groups": normalize_source_group_refs(rule.get("blacklist_groups", []), group_ids, f"{rule_id}.blacklist_groups"),
            "note": str(rule.get("note", "")).strip()[:500],
        }
        inline_allow = ensure_inline_group(source_groups, group_ids, rule.get("whitelist", []), f"{rule_id} 允许来源")
        if inline_allow:
            normalized_rule["source_groups"].append(inline_allow)
            normalized_rule["source_groups"] = sorted(set(normalized_rule["source_groups"]))
        inline_blacklist = ensure_inline_group(source_groups, group_ids, rule.get("blacklist", []), f"{rule_id} 黑名单")
        if inline_blacklist:
            normalized_rule["blacklist_enabled"] = True
            normalized_rule["blacklist_groups"].append(inline_blacklist)
            normalized_rule["blacklist_groups"] = sorted(set(normalized_rule["blacklist_groups"]))
        if REQUIRED_GROUP_ID not in normalized_rule["source_groups"]:
            normalized_rule["source_groups"].insert(0, REQUIRED_GROUP_ID)
        normalized["rules"].append(normalized_rule)
    return normalized


def backup_iptables():
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    path = BACKUP_DIR / f"iptables-{now_stamp()}.rules"
    with path.open("wb") as fh:
        proc = subprocess.run(["iptables-save"], stdout=fh, stderr=subprocess.PIPE, check=False)
    if proc.returncode != 0:
        raise AppError(proc.stderr.decode("utf-8", "replace").strip() or "iptables-save failed", 500)
    return path


def list_backups():
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    items = []
    for path in sorted(BACKUP_DIR.glob("iptables-*.rules"), reverse=True):
        if not BACKUP_NAME_RE.match(path.name):
            continue
        stat = path.stat()
        items.append({"name": path.name, "size": stat.st_size, "mtime": int(stat.st_mtime)})
    return items[:40]


def backup_file_path(name):
    if not BACKUP_NAME_RE.match(name or ""):
        raise AppError("invalid backup name")
    path = BACKUP_DIR / name
    if not path.exists():
        raise AppError("backup not found", 404)
    if path.resolve().parent != BACKUP_DIR.resolve():
        raise AppError("invalid backup path")
    return path


def restore_backup(name):
    path = backup_file_path(name)
    data = path.read_bytes()
    run(["iptables-restore"], input_data=data)
    if shutil.which("netfilter-persistent"):
        run(["netfilter-persistent", "save"], check=False)


def delete_backup(name):
    path = backup_file_path(name)
    path.unlink()


def clear_all_restrictions(config):
    config = validate_config(config)
    config["drop_cn_fallback"] = False
    config["block_cn_all_ports"] = False
    for rule in config["rules"]:
        rule["enabled"] = True
        rule["mode"] = "open"
        if REQUIRED_GROUP_ID not in rule["source_groups"]:
            rule["source_groups"].insert(0, REQUIRED_GROUP_ID)
        rule["blacklist_enabled"] = False
        rule["blacklist_groups"] = []
    return config


def initial_open_listening_config():
    config = json.loads(json.dumps(DEFAULT_CONFIG))
    ports = {}

    def add_port(port, proto, docker=False):
        if not port or proto not in PROTOCOLS:
            return
        item = ports.setdefault(int(port), {"protocols": set(), "docker": False})
        item["protocols"].add(proto)
        item["docker"] = item["docker"] or docker

    for row in ss_ports():
        proto = "udp" if str(row.get("proto", "")).startswith("udp") else "tcp"
        add_port(row.get("port"), proto)

    for row in docker_port_mappings():
        add_port(row.get("host_port"), row.get("proto"), docker=True)

    add_port(PORT, "tcp")

    rules = []
    for port in sorted(ports):
        item = ports[port]
        rules.append({
            "id": f"auto-open-{port}",
            "name": f"监听端口 {port}",
            "enabled": True,
            "scope": "both" if item["docker"] else "input",
            "protocols": sorted(item["protocols"]),
            "ports": [port],
            "docker_ports": [port] if item["docker"] else [],
            "mode": "open",
            "source_groups": [REQUIRED_GROUP_ID],
            "blacklist_enabled": False,
            "blacklist_groups": [],
            "note": "首次安装自动开放当前监听端口。",
        })
    config["rules"] = rules
    return config


def chain_exists(chain):
    return run(["iptables", "-S", chain], check=False)[0] == 0


def ensure_chain(chain):
    if not chain_exists(chain):
        run(["iptables", "-N", chain])
    run(["iptables", "-F", chain])


def ensure_chain_bin(binary, chain):
    if not binary_chain_exists(binary, chain):
        run([binary, "-N", chain])
    run([binary, "-F", chain])


def ensure_jump(parent, chain):
    if run(["iptables", "-C", parent, "-j", chain], check=False)[0] != 0:
        run(["iptables", "-I", parent, "1", "-j", chain])


def ensure_jump_bin(binary, parent, chain):
    if run([binary, "-C", parent, "-j", chain], check=False)[0] != 0:
        run([binary, "-I", parent, "1", "-j", chain])


def chain_active(parent, chain):
    return run(["iptables", "-C", parent, "-j", chain], check=False)[0] == 0


def binary_chain_exists(binary, chain):
    return bool(shutil.which(binary)) and run([binary, "-S", chain], check=False)[0] == 0


def temp_open_spec():
    return ["-m", "comment", "--comment", TEMP_OPEN_COMMENT, "-j", "ACCEPT"]


def ensure_temporary_open_all():
    spec = temp_open_spec()
    for binary in ("iptables", "ip6tables"):
        if not shutil.which(binary):
            continue
        for chain in ("INPUT", "DOCKER-USER"):
            if not binary_chain_exists(binary, chain):
                continue
            if run([binary, "-C", chain] + spec, check=False)[0] != 0:
                run([binary, "-I", chain, "1"] + spec)


def remove_temporary_open_all():
    spec = temp_open_spec()
    for binary in ("iptables", "ip6tables"):
        if not shutil.which(binary):
            continue
        for chain in ("INPUT", "DOCKER-USER"):
            if not binary_chain_exists(binary, chain):
                continue
            while run([binary, "-C", chain] + spec, check=False)[0] == 0:
                run([binary, "-D", chain] + spec, check=False)


def ensure_ipset(name):
    if run(["ipset", "list", name], check=False)[0] != 0:
        run(["ipset", "create", name, "hash:net"])


def add_rule(chain, spec, target, plan, execute):
    add_rule_cmd("iptables", chain, spec, target, plan, execute)


def add_rule_cmd(binary, chain, spec, target, plan, execute):
    cmd = [binary, "-A", chain] + spec + ["-j", target]
    plan.append(" ".join(cmd))
    if execute:
        run(cmd)


def base_port_spec(proto, port):
    return ["-p", proto, "-m", proto, "--dport", str(port)]


def source_spec(src):
    return ["-s", src]


def sources_for_groups(group_ids, group_map):
    sources = []
    for group_id in group_ids:
        sources.extend(group_map.get(group_id, []))
    return list(dict.fromkeys(sources))


def emit_port_policy(chain, rule, port, proto, config, group_map, plan, execute):
    base = base_port_spec(proto, port)
    if rule.get("blacklist_enabled"):
        for src in sources_for_groups(rule.get("blacklist_groups", []), group_map):
            add_rule(chain, base + source_spec(src), "DROP", plan, execute)
    mode = rule["mode"]
    if mode == "open":
        add_rule(chain, base, "ACCEPT", plan, execute)
    elif mode == "whitelist":
        for src in sources_for_groups(rule.get("source_groups", []), group_map):
            add_rule(chain, base + source_spec(src), "ACCEPT", plan, execute)
        add_rule(chain, base, "DROP", plan, execute)
    elif mode == "block_cn":
        add_rule(chain, base + ["-m", "set", "--match-set", config["cn_set"], "src"], "DROP", plan, execute)
        add_rule(chain, base, "ACCEPT", plan, execute)
    elif mode == "blacklist":
        add_rule(chain, base, "ACCEPT", plan, execute)
    elif mode == "closed":
        add_rule(chain, base, "DROP", plan, execute)


def build_chain(chain, config, docker, plan, execute):
    group_map = {group["id"]: group["sources"] for group in config.get("source_groups", [])}
    add_rule(chain, ["-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED"], "ACCEPT", plan, execute)
    if not docker:
        add_rule(chain, ["-i", "lo"], "ACCEPT", plan, execute)
    if config["block_cn_all_ports"]:
        add_rule(chain, ["-m", "set", "--match-set", config["cn_set"], "src"], "DROP", plan, execute)
    if not docker:
        for port in safe_input_ports():
            add_rule(chain, base_port_spec("tcp", port), "ACCEPT", plan, execute)
    for rule in config["rules"]:
        if not rule["enabled"]:
            continue
        if docker and rule["scope"] not in {"docker", "both"}:
            continue
        if not docker and rule["scope"] not in {"input", "both"}:
            continue
        ports = rule["docker_ports"] if docker and rule["docker_ports"] else rule["ports"]
        for proto in rule["protocols"]:
            for port in ports:
                emit_port_policy(chain, rule, port, proto, config, group_map, plan, execute)
    if config["drop_cn_fallback"]:
        add_rule(chain, ["-m", "set", "--match-set", config["cn_set"], "src"], "DROP", plan, execute)
    add_rule(chain, [], "RETURN", plan, execute)


def emit_ipv6_port_policy(chain, rule, port, proto, plan, execute):
    base = base_port_spec(proto, port)
    mode = rule["mode"]
    if mode in {"open", "block_cn", "blacklist"}:
        add_rule_cmd("ip6tables", chain, base, "ACCEPT", plan, execute)
    elif mode in {"whitelist", "closed"}:
        add_rule_cmd("ip6tables", chain, base, "DROP", plan, execute)


def build_ipv6_chain(chain, config, docker, plan, execute):
    add_rule_cmd("ip6tables", chain, ["-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED"], "ACCEPT", plan, execute)
    if not docker:
        add_rule_cmd("ip6tables", chain, ["-i", "lo"], "ACCEPT", plan, execute)
    for rule in config["rules"]:
        if not rule["enabled"]:
            continue
        if docker and rule["scope"] not in {"docker", "both"}:
            continue
        if not docker and rule["scope"] not in {"input", "both"}:
            continue
        ports = rule["docker_ports"] if docker and rule["docker_ports"] else rule["ports"]
        for proto in rule["protocols"]:
            for port in ports:
                emit_ipv6_port_policy(chain, rule, port, proto, plan, execute)
    add_rule_cmd("ip6tables", chain, [], "RETURN", plan, execute)


def apply_ipv6_firewall(config, plan, execute):
    if not shutil.which("ip6tables"):
        return
    ensure_chain_bin("ip6tables", CHAIN_INPUT)
    ensure_jump_bin("ip6tables", "INPUT", CHAIN_INPUT)
    build_ipv6_chain(CHAIN_INPUT, config, docker=False, plan=plan, execute=execute)
    if binary_chain_exists("ip6tables", "DOCKER-USER"):
        ensure_chain_bin("ip6tables", CHAIN_DOCKER)
        ensure_jump_bin("ip6tables", "DOCKER-USER", CHAIN_DOCKER)
        build_ipv6_chain(CHAIN_DOCKER, config, docker=True, plan=plan, execute=execute)


def apply_firewall(config, create_backup=True):
    config = validate_config(config)
    ensure_temporary_open_all()
    backup = backup_iptables() if create_backup else None
    plan = []
    try:
        ensure_ipset(config["cn_set"])
        ensure_chain(CHAIN_INPUT)
        ensure_chain(CHAIN_DOCKER)
        ensure_jump("INPUT", CHAIN_INPUT)
        if chain_exists("DOCKER-USER"):
            ensure_jump("DOCKER-USER", CHAIN_DOCKER)
        build_chain(CHAIN_INPUT, config, docker=False, plan=plan, execute=True)
        if chain_exists("DOCKER-USER"):
            build_chain(CHAIN_DOCKER, config, docker=True, plan=plan, execute=True)
        apply_ipv6_firewall(config, plan, execute=True)
        remove_temporary_open_all()
        if config["persist"] and shutil.which("netfilter-persistent"):
            run(["netfilter-persistent", "save"])
    except Exception:
        if backup is not None:
            try:
                run(["iptables-restore"], input_data=backup.read_bytes(), check=False)
                ensure_temporary_open_all()
            finally:
                raise
        remove_temporary_open_all()
        raise
    write_json(CONFIG_FILE, config)
    return {"backup": backup.name if backup else None, "commands": plan}


def preview_firewall(config):
    config = validate_config(config)
    plan = [
        f"iptables -I INPUT 1 -m comment --comment {TEMP_OPEN_COMMENT} -j ACCEPT  # apply-time failsafe",
        f"iptables -I DOCKER-USER 1 -m comment --comment {TEMP_OPEN_COMMENT} -j ACCEPT  # apply-time failsafe",
        f"iptables -N {CHAIN_INPUT} 2>/dev/null || true",
        f"iptables -N {CHAIN_DOCKER} 2>/dev/null || true",
        f"iptables -F {CHAIN_INPUT}",
        f"iptables -F {CHAIN_DOCKER}",
        f"iptables -I INPUT 1 -j {CHAIN_INPUT}  # if missing",
        f"iptables -I DOCKER-USER 1 -j {CHAIN_DOCKER}  # if missing",
    ]
    build_chain(CHAIN_INPUT, config, docker=False, plan=plan, execute=False)
    build_chain(CHAIN_DOCKER, config, docker=True, plan=plan, execute=False)
    if config["persist"]:
        plan.append("netfilter-persistent save")
    return plan


def get_iptables(chain):
    rc, out, err = run(["iptables", "-S", chain], check=False)
    return out.strip().splitlines() if rc == 0 else []


def ipset_names():
    rc, out, err = run(["ipset", "list", "-n"], check=False)
    return [line.strip() for line in out.splitlines() if line.strip()] if rc == 0 else []


def ss_ports():
    rc, out, err = run(["ss", "-H", "-tulpen"], check=False)
    rows = []
    for line in out.splitlines():
        parts = line.split()
        if len(parts) < 5:
            continue
        proto = parts[0]
        local = parts[4]
        m = re.search(r":(\d+)$", local)
        if not m:
            continue
        proc = ""
        if "users:" in line:
            proc = line[line.find("users:"):]
        rows.append({"proto": proto, "port": int(m.group(1)), "local": local, "process": proc[:180]})
    unique = {}
    for row in rows:
        key = (row["proto"], row["port"], row["local"], row["process"])
        unique[key] = row
    return sorted(unique.values(), key=lambda x: (x["port"], x["proto"], x["local"]))


def docker_ports():
    rc, out, err = run(["docker", "ps", "--format", "{{.Names}}\t{{.Image}}\t{{.Ports}}"], check=False)
    rows = []
    if rc != 0:
        return rows
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) != 3:
            continue
        rows.append({"name": parts[0], "image": parts[1], "ports": parts[2]})
    return rows


def docker_port_mappings():
    mappings = []
    for row in docker_ports():
        ports = row.get("ports", "")
        for chunk in ports.split(","):
            chunk = chunk.strip()
            if "->" not in chunk:
                continue
            match = re.search(r"(?:(?P<host_ip>[\[\]0-9a-fA-F:.]+):)?(?P<host_port>\d+)->(?P<container_port>\d+)/(?P<proto>tcp|udp)", chunk)
            if not match:
                continue
            host_ip = (match.group("host_ip") or "").strip("[]")
            mappings.append({
                "name": row["name"],
                "image": row["image"],
                "host_ip": host_ip,
                "host_port": int(match.group("host_port")),
                "container_port": int(match.group("container_port")),
                "proto": match.group("proto"),
                "raw": chunk,
            })
    deduped = {}
    for item in mappings:
        key = (item["name"], item["host_ip"], item["host_port"], item["container_port"], item["proto"])
        deduped[key] = item
    return sorted(deduped.values(), key=lambda x: (x["host_port"], x["proto"], x["name"]))


def update_cn_set():
    config = validate_config(read_json(CONFIG_FILE, DEFAULT_CONFIG))
    set_name = config["cn_set"]
    url = "https://www.ipdeny.com/ipblocks/data/countries/cn.zone"
    data = urlopen(url, timeout=20).read().decode("utf-8")
    networks = []
    for line in data.splitlines():
        line = line.strip()
        if not line:
            continue
        networks.append(str(ipaddress.ip_network(line, strict=False)))
    ensure_ipset(set_name)
    run(["ipset", "flush", set_name])
    for net in networks:
        run(["ipset", "add", set_name, net])
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    (CONFIG_DIR / f"{set_name}.zone").write_text("\n".join(networks) + "\n", encoding="utf-8")
    if shutil.which("netfilter-persistent"):
        run(["netfilter-persistent", "save"], check=False)
    return {"entries": len(networks), "set": set_name}


def app_status():
    config = validate_config(read_json(CONFIG_FILE, DEFAULT_CONFIG))
    return {
        "config": config,
        "chains": {
            "input": get_iptables(CHAIN_INPUT),
            "docker": get_iptables(CHAIN_DOCKER),
            "input_active": chain_active("INPUT", CHAIN_INPUT),
            "docker_active": chain_exists("DOCKER-USER") and chain_active("DOCKER-USER", CHAIN_DOCKER),
            "legacy_input": get_iptables("INPUT")[:160],
            "legacy_docker": get_iptables("DOCKER-USER")[:160],
        },
        "ipsets": ipset_names(),
        "ports": ss_ports(),
        "docker": docker_ports(),
        "docker_mappings": docker_port_mappings(),
        "backups": list_backups(),
        "server": {
            "bind": BIND,
            "port": PORT,
            "persist_available": bool(shutil.which("netfilter-persistent")),
            "time": int(time.time()),
        }
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "PortGuardUI/1.0"

    def log_message(self, fmt, *args):
        print(f"{self.address_string()} - {fmt % args}")

    def send_json(self, data, status=200, headers=None):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, message, status=400):
        self.send_json({"ok": False, "error": message}, status)

    def client_ip(self):
        return self.client_address[0] if self.client_address else "unknown"

    def authenticated(self):
        cookies = parse_cookie(self.headers.get("Cookie", ""))
        return verify_session(cookies.get("pg_session", ""))

    def require_auth(self):
        if not self.authenticated():
            raise AppError("unauthorized", 401)

    def do_GET(self):
        try:
            parsed = urlparse(self.path)
            if parsed.path == "/api/status":
                self.require_auth()
                self.send_json({"ok": True, "data": app_status()})
                return
            if parsed.path == "/api/preview":
                self.require_auth()
                config = read_json(CONFIG_FILE, DEFAULT_CONFIG)
                self.send_json({"ok": True, "data": preview_firewall(config)})
                return
            if parsed.path.startswith("/api/"):
                raise AppError("not found", 404)
            self.serve_static(parsed.path)
        except AppError as exc:
            self.send_error_json(str(exc), exc.status)
        except Exception as exc:
            self.send_error_json(str(exc), 500)

    def do_POST(self):
        try:
            parsed = urlparse(self.path)
            if parsed.path == "/api/login":
                ip = self.client_ip()
                locked = login_lock_seconds(ip)
                if locked:
                    raise AppError(f"尝试次数过多，请 {locked} 秒后再试", 429)
                data = json_body(self)
                password = str(data.get("password", data.get("token", "")))
                if verify_login_password(password):
                    clear_login_failures(ip)
                    expiry = int(time.time()) + 8 * 3600
                    cookie = f"pg_session={sign_session(expiry)}; HttpOnly; SameSite=Strict; Path=/; Max-Age={8 * 3600}"
                    self.send_json({"ok": True}, headers={"Set-Cookie": cookie})
                    return
                record_login_failure(ip)
                raise AppError("密码错误", 401)
            self.require_auth()
            data = json_body(self)
            if parsed.path == "/api/logout":
                self.send_json({"ok": True}, headers={"Set-Cookie": "pg_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"})
            elif parsed.path == "/api/password":
                result = change_login_password(data.get("current_password", ""), data.get("new_password", ""))
                self.send_json({"ok": True, "data": result})
            elif parsed.path == "/api/config":
                config = validate_config(data.get("config", data))
                write_json(CONFIG_FILE, config)
                self.send_json({"ok": True, "data": config})
            elif parsed.path == "/api/preview":
                config = validate_config(data.get("config", data))
                self.send_json({"ok": True, "data": preview_firewall(config)})
            elif parsed.path == "/api/apply":
                config = validate_config(data.get("config", data))
                result = apply_firewall(config)
                self.send_json({"ok": True, "data": result})
            elif parsed.path == "/api/clear-restrictions":
                config = clear_all_restrictions(data.get("config", read_json(CONFIG_FILE, DEFAULT_CONFIG)))
                result = apply_firewall(config)
                self.send_json({"ok": True, "data": {"config": config, "result": result}})
            elif parsed.path == "/api/backup":
                path = backup_iptables()
                self.send_json({"ok": True, "data": {"backup": path.name, "backups": list_backups()}})
            elif parsed.path == "/api/restore":
                restore_backup(str(data.get("name", "")))
                self.send_json({"ok": True, "data": {"restored": data.get("name")}})
            elif parsed.path == "/api/delete-backup":
                delete_backup(str(data.get("name", "")))
                self.send_json({"ok": True, "data": {"deleted": data.get("name"), "backups": list_backups()}})
            elif parsed.path == "/api/update-cn":
                result = update_cn_set()
                self.send_json({"ok": True, "data": result})
            else:
                raise AppError("not found", 404)
        except AppError as exc:
            self.send_error_json(str(exc), exc.status)
        except Exception as exc:
            self.send_error_json(str(exc), 500)

    def serve_static(self, path):
        if path in {"", "/"}:
            path = "/index.html"
        rel = Path(path.lstrip("/"))
        static_root = STATIC_DIR.resolve()
        target = (static_root / rel).resolve()
        try:
            target.relative_to(static_root)
        except ValueError:
            raise AppError("not found", 404)
        if not target.exists() or not target.is_file():
            raise AppError("not found", 404)
        ctype = "text/plain; charset=utf-8"
        if target.suffix == ".html":
            ctype = "text/html; charset=utf-8"
        elif target.suffix == ".css":
            ctype = "text/css; charset=utf-8"
        elif target.suffix == ".js":
            ctype = "application/javascript; charset=utf-8"
        body = target.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    if os.geteuid() != 0:
        raise SystemExit("port-guard-ui must run as root to manage iptables")
    ensure_dirs()
    httpd = ThreadingHTTPServer((BIND, PORT), Handler)
    print(f"Port Guard UI listening on http://{BIND}:{PORT}")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
