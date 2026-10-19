#!/usr/bin/env bash
# 构建并发布到自有服务器上 Caddy 站点的子路径（默认 https://tool.talium.site/Anime2Real/），见 docs/Development.md。
#
# - 只发布已推送的提交：页面中的源代码链接（AGPL §13）指向构建时的提交。
# - 每次发布放在 releases/<时间>-<提交>/，与上一版相同的文件（主要是模型）以硬链接复用，不重复上传；
#   current 软链接指向当前版本，切换是原子的，保留最近 3 个版本。
# - 路由写在单独的 /etc/caddy/anime2real.caddy 中，由站点块开头的 import 行引入，不改动站点块里的其他内容。
#   新的 Caddyfile 先通过 caddy validate 再替换；上线后检查失败时恢复原来的配置和版本。
set -euo pipefail

HOST=${A2R_DEPLOY_HOST:-tencent}                # ssh 主机，需要免密 sudo
SITE=${A2R_DEPLOY_SITE:-tool.talium.site}       # Caddyfile 中已有的站点地址
BASE=${A2R_DEPLOY_BASE:-/Anime2Real}            # 子路径，不带结尾的 /
DIR=${A2R_DEPLOY_DIR:-/var/www/${SITE}${BASE}}  # 服务器上的发布目录
ROUTE=${A2R_DEPLOY_ROUTE:-/etc/caddy/anime2real.caddy}
KEEP=3

cd "$(dirname "$0")/.."

fail() {
  echo "部署中止：$*" >&2
  exit 1
}

[[ -z "$(git status --porcelain)" ]] || fail '工作区有未提交的改动'
commit=$(git rev-parse HEAD)
git merge-base --is-ancestor "$commit" origin/main || fail "提交 ${commit:0:7} 还没有推送到 origin/main"

pnpm build

release="$(date -u +%Y%m%dT%H%M%SZ)-${commit:0:7}"
digest=$(sha256sum dist/index.html | cut -d' ' -f1)

route=$(cat <<EOF
# Anime2Real 的路由，由 Anime2Rel 仓库的 scripts/deploy.sh 维护，手工改动会在下次部署时被覆盖。
# 本文件在 ${SITE} {} 内被 import。

# 页面使用相对路径引用资源，目录必须带结尾的 /。
redir ${BASE} ${BASE}/ 308

handle_path ${BASE}/* {
	root * ${DIR}/current
	header {
		# 跨源隔离：WebAssembly 多线程推理需要
		Cross-Origin-Opener-Policy same-origin
		Cross-Origin-Embedder-Policy credentialless
		X-Content-Type-Options nosniff
		Referrer-Policy strict-origin-when-cross-origin
	}
	route {
		# 构建产物的文件名带内容哈希，模型放在带版本号的目录里，都可以永久缓存
		@immutable path /assets/* /models/*
		header @immutable Cache-Control "public, max-age=31536000, immutable"
		@entry not path /assets/* /models/*
		header @entry Cache-Control "no-cache"
		file_server
	}
}
EOF
)

echo "上传 ${release} 到 ${HOST}:${DIR}"
ssh "$HOST" "sudo -n install -d -o \"\$(id -un)\" -g \"\$(id -gn)\" -m 755 '${DIR}' '${DIR}/releases'"
link_dest=()
ssh "$HOST" "test -d '${DIR}/current'" && link_dest=(--link-dest="${DIR}/current/")
rsync -rl --checksum --chmod=D755,F644 --info=stats1 "${link_dest[@]}" dist/ "${HOST}:${DIR}/releases/${release}/"

echo '启用新版本'
# 远端脚本的参数：站点、路由文件、发布目录、版本、子路径、index.html 的 SHA-256、保留的版本数、路由内容（base64）
ssh "$HOST" sudo -n bash -s -- "$SITE" "$ROUTE" "$DIR" "$release" "$BASE" "$digest" "$KEEP" "$(base64 -w0 <<<"$route")" <<'REMOTE'
set -euo pipefail
site=$1 route=$2 dir=$3 release=$4 base=$5 digest=$6 keep=$7
caddyfile=/etc/caddy/Caddyfile
backup=$(mktemp -d /tmp/anime2real-deploy.XXXXXX)
trap 'rm -rf "$backup"' EXIT

base64 -d <<<"$8" >"$backup/route.new"
cp "$caddyfile" "$backup/Caddyfile"
[[ -f $route ]] && cp "$route" "$backup/route.old"
previous=$(readlink "$dir/current" || true)

# 站点块开头加上 import 行（已有时不变）
import="import $route"
cp "$caddyfile" "$backup/Caddyfile.new"
if ! grep -q "^[[:space:]]*${import}[[:space:]]*\$" "$caddyfile"; then
  [[ $(grep -c "^${site} {$" "$caddyfile") == 1 ]] || { echo "Caddyfile 中找不到唯一的站点块 ${site}" >&2; exit 1; }
  sed -i "s|^${site} {\$|&\n\t${import}|" "$backup/Caddyfile.new"
fi

# 在 /etc/caddy 中校验，import 的相对路径与正式配置一致
install -m 644 "$backup/route.new" "$route"
cp "$backup/Caddyfile.new" /etc/caddy/.anime2real-candidate
if ! caddy validate --config /etc/caddy/.anime2real-candidate --adapter caddyfile >/dev/null 2>"$backup/validate.log"; then
  cat "$backup/validate.log" >&2
  rm -f /etc/caddy/.anime2real-candidate
  if [[ -f $backup/route.old ]]; then cp "$backup/route.old" "$route"; else rm -f "$route"; fi
  exit 1
fi
mv /etc/caddy/.anime2real-candidate "$caddyfile"

rollback() {
  echo '上线检查失败，恢复原来的配置和版本' >&2
  cp "$backup/Caddyfile" "$caddyfile"
  if [[ -f $backup/route.old ]]; then cp "$backup/route.old" "$route"; else rm -f "$route"; fi
  if [[ -n $previous ]]; then ln -sfn "$previous" "$dir/.current-new" && mv -T "$dir/.current-new" "$dir/current"; else rm -f "$dir/current"; fi
  systemctl reload caddy
  exit 1
}

ln -sfn "releases/$release" "$dir/.current-new"
mv -T "$dir/.current-new" "$dir/current"
systemctl reload caddy || rollback

online=$(curl -fsS --max-time 20 --resolve "$site:443:127.0.0.1" "https://$site$base/" | sha256sum | cut -d' ' -f1) || rollback
[[ $online == "$digest" ]] || rollback
curl -fsSI --max-time 20 --resolve "$site:443:127.0.0.1" "https://$site$base/" | grep -qi '^cross-origin-embedder-policy: credentialless' || rollback

# 只保留最近的几个版本
ls -1d "$dir"/releases/*/ | sort | head -n "-$keep" | while read -r old; do
  [[ $(basename "$old") == "$release" ]] || rm -rf "$old"
done
echo "已上线：https://$site$base/"
REMOTE
