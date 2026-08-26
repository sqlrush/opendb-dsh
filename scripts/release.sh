#!/usr/bin/env bash
# 发布一个版本（在 mac 上跑：需要 docker / kubectl / gh）：
#   scripts/release.sh 0.2.0            # 打版本、打 tag、推 GitHub、构建并推送带版本号的镜像、建 GitHub Release
#   scripts/release.sh 0.2.0 --no-image # 跳过镜像
# 规则：
#   - 产品版本唯一来源 = 根 package.json 的 version；chart 的 version/appVersion 同步改
#   - CHANGELOG.md 必须已经有 "## [X.Y.Z]" 段（发布说明从这里取），否则拒绝发布
#   - 工作区必须干净且在 main；tag 形如 vX.Y.Z
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.orbstack/bin:$HOME/.local/bin"

VER="${1:-}"; NO_IMAGE="${2:-}"
[[ "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "用法: scripts/release.sh X.Y.Z [--no-image]"; exit 2; }
TAG="v$VER"
[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || { echo "必须在 main 上发布"; exit 2; }
[ -z "$(git status --porcelain)" ] || { echo "工作区不干净，先提交"; exit 2; }
git fetch -q origin && [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "本地 main 与 origin/main 不一致，先 pull/push"; exit 2; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "tag $TAG 已存在"; exit 2; }
grep -q "^## \[$VER\]" CHANGELOG.md || { echo "CHANGELOG.md 里没有 '## [$VER]' 段，先写发布说明"; exit 2; }

# 1) 版本号：根 package.json + chart
node -e "const fs=require('fs');const p='package.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));j.version='$VER';fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n')"
sed -i '' -E "s/^version: .*/version: $VER/; s/^appVersion: .*/appVersion: \"$VER\"/" deploy/charts/opendb-dsh/Chart.yaml
git add package.json deploy/charts/opendb-dsh/Chart.yaml
git commit -q -m "chore(release): $TAG" || true
git tag -a "$TAG" -m "opendb-harness $TAG"
git push -q origin main "$TAG"
echo "tag $TAG 已推送"

# 2) 镜像：dev 之外再打一个带版本号的标签（chart 默认仍用 dev；要固定到版本时 helm --set image.tag=$TAG）
if [ "$NO_IMAGE" != "--no-image" ]; then
  bash deploy/k8s/build-image.sh
  docker tag localhost:5050/opendb-dsh:dev "localhost:5050/opendb-dsh:$TAG"
  docker push -q "localhost:5050/opendb-dsh:$TAG"
  echo "镜像 localhost:5050/opendb-dsh:$TAG 已推送"
fi

# 3) GitHub Release：发布说明 = CHANGELOG 里该版本的段落
NOTES="$(awk -v v="$VER" '$0 ~ "^## \\["v"\\]" {p=1; next} /^## \[/ {p=0} p' CHANGELOG.md)"
gh release create "$TAG" --title "opendb-harness $TAG" --notes "$NOTES" >/dev/null && echo "GitHub Release $TAG 已创建：$(gh release view "$TAG" --json url -q .url)"
