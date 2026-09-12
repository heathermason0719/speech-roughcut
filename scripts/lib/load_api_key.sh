# 解析 VOLCENGINE_API_KEY —— 与具体 agent / 安装位置无关。
#
# 查找顺序：
#   1) 环境变量 $VOLCENGINE_API_KEY
#   2) $VOLCENGINE_ENV_FILE 指定的 .env
#   3) <skill 目录>/.env          （推荐：跟着 skill 走，换 agent 也不丢）
#   4) <skill 目录的上一级>/.env   （兼容 Claude Code 旧约定 ~/.claude/skills/.env）
#
# 调用方需先设置 SCRIPT_DIR=脚本所在目录；source 本文件后 $API_KEY 可用，配置无效则退出 1。
# 与 doctor 共用解析：文件允许空白/成对引号，保留值内部字节，重复 key 拒绝。

_skill_dir="$(dirname "$SCRIPT_DIR")"
API_KEY="$(node "$SCRIPT_DIR/lib/provider_config.js" "$_skill_dir")" || exit 1
