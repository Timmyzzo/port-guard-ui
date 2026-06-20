<div align="center">

# Port Guard UI

**Linux 服务器端口防火墙可视化管理面板**

![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?style=flat-square&logo=python&logoColor=white)
![iptables](https://img.shields.io/badge/%E9%98%B2%E7%81%AB%E5%A2%99-iptables%20%2B%20ipset-2F855A?style=flat-square)
![Docker](https://img.shields.io/badge/Docker-%E7%AB%AF%E5%8F%A3%E8%AF%86%E5%88%AB-2496ED?style=flat-square&logo=docker&logoColor=white)
![No Build](https://img.shields.io/badge/%E5%89%8D%E7%AB%AF-%E6%97%A0%E9%9C%80%E6%9E%84%E5%BB%BA-6B7280?style=flat-square)

一个轻量、直观、适合个人 VPS 和云服务器的端口开放管理工具。

</div>

---

## 默认策略

> **安装完成后默认全部敞开所有端口。**
>
> Port Guard UI 的初始配置不会限制任何端口；README 中提供的一键部署脚本默认启用 `PG_OPEN_ALL=1`，会先备份当前 iptables 规则，再尝试放开常见本机防火墙限制，让服务器在本机防火墙层面保持全开放。

需要特别明确几件事：

| 项目 | 默认行为 |
| --- | --- |
| Port Guard UI 初始规则 | 不创建任何端口限制 |
| 一键部署脚本 | 默认备份并放开本机防火墙限制 |
| 面板访问方式 | 默认监听 `127.0.0.1:8787`，建议通过 SSH 隧道访问 |
| 云厂商安全组 | 需要你在云控制台单独放行，脚本无法替你修改云平台安全组 |

如果你不想在安装阶段自动全开放本机防火墙，请把下面一键部署命令中的 `PG_OPEN_ALL=1` 改为：

```bash
PG_OPEN_ALL=0
```

---

## 这个项目能做什么

Port Guard UI 会扫描宿主机监听端口和 Docker 映射端口，把常见访问策略整理成可视化规则。你可以在网页里完成端口托管、策略组放行、黑名单、CN 拦截、备份回滚等操作。

| 能力 | 说明 |
| --- | --- |
| 端口扫描 | 读取 `ss` 和 Docker 映射，区分宿主机端口和容器发布端口 |
| 托管全部监听 | 一键把当前检测到的监听端口加入规则，默认全网开放 |
| 访问策略 | 支持全网开放、策略组放行、禁止中国 IP、除黑名单外开放、仅本机/隧道 |
| 策略组 | 用来源组维护内网 IP、个人 IP、可信来源，可复用到多个端口 |
| CN 拦截 | 通过 `ipset` 维护中国大陆网段，可按端口或全局启用 |
| 自动备份 | 应用规则前自动保存 iptables 备份，方便回滚 |
| Docker 识别 | 自动展示 Docker 已发布端口，支持托管容器入口 |
| 轻量部署 | 单个 Python 服务加静态前端，无数据库、无前端构建流程 |

---

## 适用环境

推荐环境：

| 环境 | 要求 |
| --- | --- |
| 操作系统 | Linux 服务器，推荐 Debian / Ubuntu / CentOS / Rocky / AlmaLinux / Fedora |
| 权限 | root 或具备 `sudo` 权限的用户 |
| Python | Python 3.10 或更高版本 |
| 防火墙工具 | `iptables`、`iptables-save`、`iptables-restore`、`ipset` |
| 端口扫描 | `iproute2` 提供的 `ss` 命令 |
| 服务管理 | 推荐 systemd |
| Docker | 可选；安装 Docker CLI 后可识别容器映射端口 |

> Alpine / OpenRC 等非 systemd 系统可以手动运行 `server.py`，但 README 的一键部署脚本默认面向 systemd 服务器。

---

## 从零开始部署

下面流程适合一台带默认防火墙、默认系统设置的全新 VPS 或云服务器。

### 1. 登录服务器

```bash
ssh root@你的服务器公网IP
```

如果你使用了非 22 端口，例如 `22222`：

```bash
ssh root@你的服务器公网IP -p 22222
```

### 2. 安装 git 并拉取项目

Debian / Ubuntu：

```bash
sudo apt update
sudo apt install -y git
git clone https://github.com/Timmyzzo/port-guard-ui.git
cd port-guard-ui
```

CentOS / Rocky / AlmaLinux / Fedora：

```bash
sudo dnf install -y git || sudo yum install -y git
git clone https://github.com/Timmyzzo/port-guard-ui.git
cd port-guard-ui
```

### 3. 一键检测、安装、启动、默认全开放

在项目目录中直接执行下面这段命令。

默认行为：

- 自动检测系统和包管理器。
- 自动安装 Python、iptables、ipset、iproute2 等依赖。
- 自动安装到 `/opt/port-guard-ui`。
- 自动生成访问令牌和 Cookie 密钥。
- 自动注册并启动 systemd 服务。
- **默认 `PG_OPEN_ALL=1`，安装后会备份当前规则并放开本机防火墙限制。**

```bash
sudo env PG_SSH_PORT=22 PG_OPEN_ALL=1 PG_BIND=127.0.0.1 PG_PORT=8787 bash -s <<'EOF'
set -euo pipefail

APP_DIR="/opt/port-guard-ui"
CONFIG_DIR="/etc/port-guard-ui"
BACKUP_DIR="/var/backups/port-guard-ui"
ENV_FILE="/etc/port-guard-ui.env"
SERVICE_FILE="/etc/systemd/system/port-guard-ui.service"
HTTP_BIND="${PG_BIND:-127.0.0.1}"
HTTP_PORT="${PG_PORT:-8787}"
SSH_PORT="${PG_SSH_PORT:-22}"
OPEN_ALL="${PG_OPEN_ALL:-1}"
SRC_DIR="$(pwd)"

if [ "$(id -u)" -ne 0 ]; then
  echo "请使用 root 或 sudo 运行。"
  exit 1
fi

if [ ! -f "$SRC_DIR/server.py" ] || [ ! -d "$SRC_DIR/static" ]; then
  echo "请在 port-guard-ui 项目根目录中运行此脚本。"
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "未检测到 systemd。请参考 README 的手动运行方式。"
  exit 1
fi

detect_system() {
  echo "==> 系统检测"
  if [ -r /etc/os-release ]; then
    . /etc/os-release
    echo "系统: ${PRETTY_NAME:-unknown}"
  else
    echo "系统: unknown"
  fi

  if command -v apt-get >/dev/null 2>&1; then
    echo "包管理器: apt"
  elif command -v dnf >/dev/null 2>&1; then
    echo "包管理器: dnf"
  elif command -v yum >/dev/null 2>&1; then
    echo "包管理器: yum"
  elif command -v pacman >/dev/null 2>&1; then
    echo "包管理器: pacman"
  else
    echo "包管理器: 未识别"
  fi

  for svc in ufw firewalld nftables docker; do
    if systemctl list-unit-files "$svc.service" >/dev/null 2>&1; then
      state="$(systemctl is-active "$svc" 2>/dev/null || true)"
      echo "服务 $svc: ${state:-unknown}"
    fi
  done
}

install_packages() {
  echo "==> 安装依赖"
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y python3 iptables ipset iproute2 curl ca-certificates
    DEBIAN_FRONTEND=noninteractive apt-get install -y netfilter-persistent || true
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y python3 iptables ipset iproute curl ca-certificates
  elif command -v yum >/dev/null 2>&1; then
    yum install -y python3 iptables ipset iproute curl ca-certificates
  elif command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm python iptables ipset iproute2 curl ca-certificates
  else
    echo "无法识别包管理器，请手动安装 python3、iptables、ipset、iproute2。"
    exit 1
  fi
}

random_secret() {
  python3 - <<'PY'
import secrets
print(secrets.token_hex(24))
PY
}

check_python() {
  python3 - <<'PY'
import sys
if sys.version_info < (3, 10):
    raise SystemExit("需要 Python 3.10 或更高版本，请先升级系统 Python。")
print("Python 版本符合要求。")
PY
}

install_app() {
  echo "==> 安装 Port Guard UI"
  install -d -m 0755 "$APP_DIR" "$CONFIG_DIR" "$BACKUP_DIR"
  install -m 0644 "$SRC_DIR/server.py" "$APP_DIR/server.py"
  install -d -m 0755 "$APP_DIR/static"
  cp -a "$SRC_DIR/static/." "$APP_DIR/static/"

  TOKEN="$(random_secret)"
  SECRET="$(random_secret)"

  cat > "$ENV_FILE" <<ENV
PORT_GUARD_HOME=$APP_DIR
PORT_GUARD_CONFIG_DIR=$CONFIG_DIR
PORT_GUARD_BACKUP_DIR=$BACKUP_DIR
PORT_GUARD_BIND=$HTTP_BIND
PORT_GUARD_PORT=$HTTP_PORT
PORT_GUARD_TOKEN=$TOKEN
PORT_GUARD_SECRET=$SECRET
PORT_GUARD_SAFE_INPUT_PORTS=$SSH_PORT
ENV
  chmod 600 "$ENV_FILE"

  install -m 0644 "$SRC_DIR/examples/port-guard-ui.service" "$SERVICE_FILE"
  systemctl daemon-reload
  systemctl enable --now port-guard-ui

  echo "访问令牌已写入: $ENV_FILE"
  echo "当前访问令牌: $TOKEN"
}

open_all_ports() {
  echo "==> 默认全开放本机防火墙"
  install -d -m 0755 "$BACKUP_DIR"
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

  if command -v iptables-save >/dev/null 2>&1; then
    iptables-save > "$BACKUP_DIR/iptables-before-open-all-$STAMP.rules" 2>/dev/null || true
  fi
  if command -v ip6tables-save >/dev/null 2>&1; then
    ip6tables-save > "$BACKUP_DIR/ip6tables-before-open-all-$STAMP.rules" 2>/dev/null || true
  fi

  if command -v ufw >/dev/null 2>&1; then
    ufw --force disable || true
  fi

  for svc in firewalld nftables; do
    if systemctl list-unit-files "$svc.service" >/dev/null 2>&1; then
      systemctl stop "$svc" 2>/dev/null || true
      systemctl disable "$svc" 2>/dev/null || true
    fi
  done

  for bin in iptables ip6tables; do
    if command -v "$bin" >/dev/null 2>&1; then
      "$bin" -P INPUT ACCEPT 2>/dev/null || true
      "$bin" -P FORWARD ACCEPT 2>/dev/null || true
      "$bin" -P OUTPUT ACCEPT 2>/dev/null || true
      "$bin" -F INPUT 2>/dev/null || true
      "$bin" -F OUTPUT 2>/dev/null || true
      "$bin" -F PORTGUARD-INPUT 2>/dev/null || true
      "$bin" -F PORTGUARD-DOCKER 2>/dev/null || true
      if "$bin" -S DOCKER-USER >/dev/null 2>&1; then
        "$bin" -F DOCKER-USER 2>/dev/null || true
        "$bin" -A DOCKER-USER -j RETURN 2>/dev/null || true
      fi
    fi
  done

  if command -v netfilter-persistent >/dev/null 2>&1; then
    netfilter-persistent save || true
  fi

  echo "本机防火墙已按全开放模式处理，备份目录: $BACKUP_DIR"
}

detect_system
install_packages
check_python
install_app

if [ "$OPEN_ALL" = "1" ]; then
  open_all_ports
else
  echo "已跳过全开放处理，因为 PG_OPEN_ALL=$OPEN_ALL"
fi

systemctl status port-guard-ui --no-pager -l || true

cat <<INFO

部署完成。

面板地址: http://127.0.0.1:$HTTP_PORT
SSH 隧道: ssh -L $HTTP_PORT:127.0.0.1:$HTTP_PORT root@你的服务器公网IP -p $SSH_PORT
令牌文件: $ENV_FILE

重要提醒:
1. 本脚本默认只处理服务器本机防火墙。
2. 如果云厂商安全组没有放行，对外端口仍然无法访问。
3. 面板默认只监听 127.0.0.1，需要 SSH 隧道访问。
INFO
EOF
```

### 4. 打开面板

在你的本地电脑执行 SSH 隧道命令：

```bash
ssh -L 8787:127.0.0.1:8787 root@你的服务器公网IP -p 22
```

然后在浏览器打开：

```text
http://127.0.0.1:8787
```

访问令牌在服务器文件中：

```bash
sudo cat /etc/port-guard-ui.env
```

找到这一行：

```text
PORT_GUARD_TOKEN=这里就是访问令牌
```

### 5. 云厂商安全组也要放行

如果你希望公网能访问服务器上的业务端口，需要到云厂商控制台放行入站规则。

通用建议：

| 协议 | 端口 | 来源 |
| --- | --- | --- |
| TCP | `1-65535` | `0.0.0.0/0` |
| UDP | `1-65535` | `0.0.0.0/0` |
| ICMP | 全部 | `0.0.0.0/0` |

如果云平台支持 IPv6，也需要同步配置 `::/0` 的入站规则。

---

## 手动部署方式

如果你不想使用上面的一键脚本，可以手动安装。

### 1. 安装依赖

Debian / Ubuntu：

```bash
sudo apt update
sudo apt install -y python3 iptables ipset iproute2 netfilter-persistent
```

CentOS / Rocky / AlmaLinux / Fedora：

```bash
sudo dnf install -y python3 iptables ipset iproute || sudo yum install -y python3 iptables ipset iproute
```

### 2. 安装文件

```bash
sudo mkdir -p /opt/port-guard-ui /etc/port-guard-ui /var/backups/port-guard-ui
sudo cp server.py /opt/port-guard-ui/server.py
sudo cp -r static /opt/port-guard-ui/static
sudo cp examples/port-guard-ui.env.example /etc/port-guard-ui.env
sudo cp examples/port-guard-ui.service /etc/systemd/system/port-guard-ui.service
```

编辑环境变量：

```bash
sudo nano /etc/port-guard-ui.env
```

建议至少修改：

```text
PORT_GUARD_TOKEN=换成一个足够长的随机字符串
PORT_GUARD_SECRET=换成另一个足够长的随机字符串
PORT_GUARD_SAFE_INPUT_PORTS=22
```

如果你的 SSH 端口不是 22，请改成你的真实 SSH 端口，例如：

```text
PORT_GUARD_SAFE_INPUT_PORTS=22222
```

### 3. 启动服务

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now port-guard-ui
sudo systemctl status port-guard-ui --no-pager
```

---

## 面板使用流程

### 端口托管

1. 通过 SSH 隧道打开 `http://127.0.0.1:8787`。
2. 输入 `/etc/port-guard-ui.env` 中的 `PORT_GUARD_TOKEN`。
3. 进入端口列表。
4. 点击“托管全部监听”。
5. 新托管的端口默认是“全网开放”。
6. 点击“应用到防火墙”。

### 一键清空所有限制

如果你已经配置过白名单、黑名单或 CN 拦截，想恢复到全开放：

1. 进入“设置”。
2. 点击“清空所有限制”。
3. 二次确认后会立即应用。
4. 所有托管端口会恢复为全网开放。

对应后端接口是：

```text
POST /api/clear-restrictions
```

### 常用访问模式

| 模式 | 效果 |
| --- | --- |
| 全网开放 | 允许所有来源访问指定端口 |
| 策略组放行 | 只允许选中的来源组访问 |
| 禁止中国 IP | 丢弃中国大陆来源 IP，其他来源放行 |
| 除黑名单外开放 | 默认开放，但拒绝黑名单来源组 |
| 仅本机/隧道 | 不开放公网直连，适合只走本机或 SSH 隧道 |

---

## 配置说明

运行时环境变量位于：

```text
/etc/port-guard-ui.env
```

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT_GUARD_HOME` | `/opt/port-guard-ui` | 应用安装目录 |
| `PORT_GUARD_CONFIG_DIR` | `/etc/port-guard-ui` | 配置文件和 CN 网段文件目录 |
| `PORT_GUARD_BACKUP_DIR` | `/var/backups/port-guard-ui` | iptables 备份目录 |
| `PORT_GUARD_BIND` | `127.0.0.1` | 面板监听地址 |
| `PORT_GUARD_PORT` | `8787` | 面板监听端口 |
| `PORT_GUARD_TOKEN` | 空 | 登录令牌；当监听非本机地址时必须设置 |
| `PORT_GUARD_SECRET` | token 或开发默认值 | Cookie 签名密钥 |
| `PORT_GUARD_SAFE_INPUT_PORTS` | `22222` | 应用规则时临时保证放行的关键端口，建议填写 SSH 端口 |

主配置文件：

```text
/etc/port-guard-ui/config.json
```

默认配置文件第一次启动时自动生成，默认 `rules` 为空，因此不会限制任何端口。

---

## 防火墙行为说明

Port Guard UI 只管理自己的链：

```text
PORTGUARD-INPUT
PORTGUARD-DOCKER
```

应用规则时会做这些事：

1. 先插入临时全开放规则，降低应用过程中断连风险。
2. 创建 iptables 备份。
3. 刷新 Port Guard 自己管理的链。
4. 按当前配置写入规则。
5. 移除临时全开放规则。
6. 如果启用了持久化并安装了 `netfilter-persistent`，自动保存规则。

备份目录：

```text
/var/backups/port-guard-ui
```

如果需要从控制台、VNC 或云厂商救援模式回滚：

```bash
sudo iptables-restore < /var/backups/port-guard-ui/iptables-YYYYMMDDTHHMMSSZ.rules
```

---

## 常用维护命令

查看服务状态：

```bash
sudo systemctl status port-guard-ui --no-pager
```

查看日志：

```bash
sudo journalctl -u port-guard-ui -f
```

重启服务：

```bash
sudo systemctl restart port-guard-ui
```

查看监听端口：

```bash
sudo ss -lntup
```

查看当前 Port Guard 链：

```bash
sudo iptables -S PORTGUARD-INPUT
sudo iptables -S PORTGUARD-DOCKER
```

重新执行全开放处理：

```bash
sudo bash -c '
set -e
mkdir -p /var/backups/port-guard-ui
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
iptables-save > "/var/backups/port-guard-ui/iptables-before-open-all-$stamp.rules" 2>/dev/null || true
ufw --force disable 2>/dev/null || true
systemctl stop firewalld nftables 2>/dev/null || true
systemctl disable firewalld nftables 2>/dev/null || true
iptables -P INPUT ACCEPT 2>/dev/null || true
iptables -P FORWARD ACCEPT 2>/dev/null || true
iptables -P OUTPUT ACCEPT 2>/dev/null || true
iptables -F INPUT 2>/dev/null || true
iptables -F OUTPUT 2>/dev/null || true
iptables -F PORTGUARD-INPUT 2>/dev/null || true
iptables -F PORTGUARD-DOCKER 2>/dev/null || true
netfilter-persistent save 2>/dev/null || true
echo "已完成本机防火墙全开放处理"
'
```

---

## 对外开放面板

默认推荐使用 SSH 隧道，不建议直接把管理面板暴露到公网。

如果你确实要让面板监听公网地址：

```bash
sudo sed -i 's/^PORT_GUARD_BIND=.*/PORT_GUARD_BIND=0.0.0.0/' /etc/port-guard-ui.env
sudo systemctl restart port-guard-ui
```

此时必须保证：

1. `PORT_GUARD_TOKEN` 已设置为足够长的随机字符串。
2. 云厂商安全组放行 `8787/tcp`。
3. 你清楚管理面板公网暴露的风险。

---

## 本地开发

在 Linux 测试机上运行：

```bash
sudo PORT_GUARD_HOME="$PWD" \
  PORT_GUARD_CONFIG_DIR="$PWD/.local/config" \
  PORT_GUARD_BACKUP_DIR="$PWD/.local/backups" \
  PORT_GUARD_BIND=127.0.0.1 \
  PORT_GUARD_PORT=8787 \
  PORT_GUARD_TOKEN=dev-token \
  python3 server.py
```

语法检查：

```bash
python3 -m py_compile server.py
node --check static/app.js
```

---

## 项目结构

```text
.
├── server.py
├── static/
│   ├── app.js
│   ├── index.html
│   └── styles.css
└── examples/
    ├── config.example.json
    ├── port-guard-ui.env.example
    └── port-guard-ui.service
```

---

## 排查问题

| 问题 | 处理方式 |
| --- | --- |
| 浏览器打不开面板 | 确认 SSH 隧道是否保持连接，检查 `systemctl status port-guard-ui` |
| 令牌忘记了 | 查看 `sudo cat /etc/port-guard-ui.env` |
| 业务端口外网访问不了 | 检查云厂商安全组是否放行，检查业务是否真的监听公网地址 |
| Docker 端口没显示 | 确认 Docker CLI 可用，并且当前用户或 root 能执行 `docker ps` |
| 应用规则后访问异常 | 进入云控制台/VNC/救援模式，用备份文件执行 `iptables-restore` |

---

<div align="center">

**Port Guard UI 默认不限制端口。一键部署脚本默认全开放本机防火墙。后续限制策略由你在面板中主动开启。**

</div>
