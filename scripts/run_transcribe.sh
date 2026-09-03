#!/bin/bash
#
# 步骤 0-4 自动化流水线
# 用法: ./run_transcribe.sh <media_file> [base_output_dir] [--engine]
#
# 引擎选项（默认 auto 轮流）:
#   （无）/--auto 每次在 flash / 标准版 间交替，分摊两份各 20h 免费额度 ≈ 共 40h
#                 （需在控制台同时开通极速版 auc_turbo 与标准版 auc 两个资源）
#   --flash       只用极速版 auc_turbo（一次直出、最快；只开了一个资源时用这个）
#   --v3-standard 只用标准版 auc（异步 submit/query 轮询）
#
# 输出: base_output_dir/1_转录/
#   ├── media_context.json
#   ├── review_audio.mp3
#   ├── volcengine_v3_result.json
#   ├── subtitles_words.json
#

set -e

MEDIA_PATH="$1"
BASE_DIR="${2:-.}"
ENGINE="auto"  # 默认 flash / 标准版 轮流，吃满两份免费额度

# 检测引擎参数（任意位置）
for arg in "$@"; do
  case "$arg" in
    --v3-standard) ENGINE="v3-standard" ;;
    --flash)       ENGINE="flash" ;;
    --auto)        ENGINE="auto" ;;
  esac
done
REQUESTED_ENGINE="$ENGINE"

if [ -z "$MEDIA_PATH" ]; then
  echo "用法: $0 <media_file> [base_output_dir] [--flash|--v3-standard]"
  exit 1
fi

if [ ! -f "$MEDIA_PATH" ]; then
  echo "❌ 媒体文件不存在: $MEDIA_PATH"
  exit 1
fi

# 依赖预检
for cmd in ffmpeg node python3 curl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "❌ 缺少依赖: $cmd"
    case "$cmd" in
      ffmpeg) echo "   macOS: brew install ffmpeg" ;;
      node)   echo "   macOS: brew install node" ;;
    esac
    exit 1
  fi
done

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export PYTHONUTF8=1  # 让子进程 python 用 UTF-8，避免中文路径/日志在某些 locale 下乱码

# --auto：在 flash / 标准版 间轮流，让两份各 20h 的免费额度都被消耗（共 ≈40h）
# 注意：本次选了哪个引擎，要等转录【成功】后才写入 .engine_toggle，
# 否则失败的运行也会白白切换引擎（下次又轮到另一个，免费额度分摊就乱了）。
TOGGLE_STATE=""
if [ "$ENGINE" = "auto" ]; then
  STATE="$SKILL_DIR/.engine_toggle"
  [ "$(cat "$STATE" 2>/dev/null)" = "flash" ] && ENGINE="v3-standard" || ENGINE="flash"
  TOGGLE_STATE="$STATE"
  echo "🔄 auto 轮流：本次用 $ENGINE"
fi

TRANSCRIBE_DIR="$BASE_DIR/1_转录"
mkdir -p "$TRANSCRIBE_DIR"

# ── 步骤 1: 建立统一审核时钟 ─────────────────────────────
# 所有正式输入都先通过 CFR/零起点/连续时间戳/rate=1 硬闸门，再生成同一规格的审核 MP3。
echo "📦 步骤1: 检查媒体..."
REVIEW_AUDIO=$(node "$SKILL_DIR/scripts/prepare_media.js" "$MEDIA_PATH" "$TRANSCRIBE_DIR")
MEDIA_CONTEXT="$TRANSCRIBE_DIR/media_context.json"
echo "✅ 审核音频: $REVIEW_AUDIO"

# 引擎能力只按实际上传的 review_audio.mp3 大小与 decoded-sample duration 判断。
COMPAT_ENGINE=$(node "$SKILL_DIR/scripts/select_transcribe_engine.js" "$REQUESTED_ENGINE" "$ENGINE" "$MEDIA_CONTEXT")
if [ "$COMPAT_ENGINE" != "$ENGINE" ]; then
  echo "🔀 审核音频超过极速版上限，本次从 $ENGINE 切换为 $COMPAT_ENGINE"
fi
ENGINE="$COMPAT_ENGINE"

# ── 步骤 2+3: 转录 ─────────────────────────────────────
echo "🚀 步骤2+3: 转录（引擎: $ENGINE）..."

case "$ENGINE" in
  flash)
    bash "$SKILL_DIR/scripts/volcengine_flash_transcribe.sh" "$REVIEW_AUDIO" "$TRANSCRIBE_DIR"
    RESULT_FILE="$TRANSCRIBE_DIR/volcengine_v3_result.json"
    ;;
  v3-standard)
    bash "$SKILL_DIR/scripts/volcengine_v3_transcribe.sh" "$REVIEW_AUDIO" "$TRANSCRIBE_DIR"
    RESULT_FILE="$TRANSCRIBE_DIR/volcengine_v3_result.json"
    ;;
  *)
    echo "❌ 未知引擎: $ENGINE"
    exit 1
    ;;
esac

echo "✅ 步骤2+3 完成"

# 转录成功后才记录本次用的引擎（auto 模式下次轮到另一个）；失败时 set -e 已提前退出，不会切换
[ -n "$TOGGLE_STATE" ] && echo "$ENGINE" > "$TOGGLE_STATE"

# ── 步骤 4: 生成字幕 ───────────────────────────────────
echo "📝 步骤4: 生成字幕..."
node "$SKILL_DIR/scripts/generate_subtitles.js" \
  "$RESULT_FILE" \
  "$MEDIA_CONTEXT" \
  "$TRANSCRIBE_DIR"

echo ""
echo "🎉 流水线完成！"
echo "   输出目录: $TRANSCRIBE_DIR"
find "$TRANSCRIBE_DIR" -maxdepth 1 -type f \( -name '*.mp3' -o -name '*.json' \) -exec ls -lh {} + 2>/dev/null | awk '{print "     "$9"  "$5}'
