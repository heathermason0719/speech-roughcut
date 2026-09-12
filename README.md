# speech-roughcut

一个支持**口播视频和纯音频**的 coding-agent skill:自动转录 → AI 识别口误/口癖/静音 → 网页波形审核 → 导出 FCPXML,拖进剪映或 Final Cut Pro 完成最后一刀。核心是一份 [`SKILL.md`](SKILL.md),**任何支持 skill、能读文件、能跑 shell 的 coding agent 都能装来用**,不绑定特定工具。
> 这个项目灵感最初来源于GitHub开源项目 videocut-skills，为了适配我自己的剪辑工作流，重写和扩展了工程导出、前端交互、视频预览、核心剪辑逻辑、语音识别和音频识别字幕等功能

![审核页界面](assets/review-ui.png)

> 审核网页:左侧逐字稿点划即删,右侧调静音留白,底部三色波形(灰=静音、红=选中删除、黄=算法额外切掉)。改到满意点「导出 FCPXML」。

## 这个 Skill 做什么

口播素材最费时的不是剪,是**找哪里该删** —— 重复重说、卡顿、口癖、长停顿。speech-roughcut 把这步交给 agent:转录全文、标出该删的片段,再起一个**本地审核网页**,让你对照声音、波形和逐字稿检查实际切点。

它**不直接改写原始媒体**,只把「哪里该删」想清楚,生成剪辑工程文件(FCPXML)交给剪辑软件做最后一刀。不使用第三方图床或临时云存储 —— 转写音频以 base64 直传火山引擎，其余处理都在本机完成。

### 主要特性

- **AI 预标口误** — 重复重说、残句、卡顿、纯语气词整句,自动选出来等你确认,不用自己逐句听
- **统一审核时钟** — MP3、M4A、WAV 与 CFR MP4/M4V/MOV 都生成一次性 `review_audio.mp3`；播放器、波形、文字、标题和导出共同消费一份整数 `compiledCutPlan`
- **声音证据决定静音** — 静音由审核音频解码后的 PCM 能量判定；ASR break 只用于辅助分段和搜索，不能单独制造静音或删除
- **原始资产不改写** — 审核使用统一音频，FCPXML 始终引用原始音频或视频资产，并按音频采样网格或 CFR 视频帧网格生成时码
- **可编辑标题字幕** — 导出时默认把转写结果一并写成 Final Cut Pro Title；短行沿用工作台分行，长行按 14 个中文字宽度拆分，导入后可逐块改字和调整样式
- **经确认后学习偏好** — 导出生成一次 invocation 的 `learning_diff.json`；只有你明确要求学习并确认候选规则后，才会更新长期经验规则
- **本地为主、免费够用** — 视频文件不上云，只有转写所需音频直传火山引擎；可使用约 40 小时免费额度

## 安装

把这个仓库地址发给你的 coding agent,说一句 **「装一下」**:

```text
https://github.com/heathermason0719/speech-roughcut
```

agent 会读 README,自己把它装到本地 skills 目录、配好环境、跑一遍自检,约 1 分钟。有文件系统权限的 agent 直接帮你装好;没有的话,也能在当前会话里照 [`SKILL.md`](SKILL.md) 直接跑一遍。

唯一需要你**亲自做**的一步:办一个**火山引擎 API Key**(语音转录用,共 **40h 免费额度**,完全够用)。装的时候 agent 会引导你把 key 填进去。

### 办火山引擎 API Key(约 2 分钟)

**1. 打开并登录[火山引擎 · 豆包语音服务](https://console.volcengine.com/speech/new/overview)控制台。**

![火山引擎豆包语音服务概览页](assets/volc-1-overview.png)

**2. 点左侧「开通管理」→ 开通「录音文件识别 1.0」的标准版或极速版。任一资源可用即可完成 setup；两个都可用时保留 auto 轮换。**

![开通录音文件识别 1.0](assets/volc-2-enable.png)

开通后在服务详情里能看到两个版本都是「已开通 · 运行中」:

| 标准版 | 极速版 |
|:---:|:---:|
| ![标准版已开通](assets/volc-3-standard.png) | ![极速版已开通](assets/volc-4-flash.png) |

**3. 点左侧「API Key 管理」,复制你的 API Key。**

![复制 API Key](assets/volc-5-apikey.png)

**4. 把 key 发给 agent,它会帮你放到正确位置**(skill 目录下的 `.env`)。也可以自己设成环境变量(任何 agent、任何安装位置都认):

```bash
export VOLCENGINE_API_KEY=粘贴你的key
```

## 使用

把视频或音频路径丢给 agent,它会先让你**选一个模式**:

```text
🎙️ 媒体:/path/to/视频.mp4（也可以是 MP3 / M4A / WAV 音频）
请选择模式:
  [A] 剪口播 — 识别口误 → 网页审核 → 导出 FCPXML 给剪映 / FCP
  [B] 转字幕 — 转录 → 输出规范字幕文本(markdown,无时间戳)
```

Skill 工作流默认输出到 `~/Movies/ROUGHCUT-OutPut/时间_媒体名_UUID/speech-roughcut/`。每次正式运行有独立 UUID；已用 BASE 不会被新的转录复用，失败重试也使用新目录。

正式脚本支持 `bash scripts/run_transcribe.sh <媒体> [BASE] [--auto|--flash|--v3-standard]`，flag 可在任意位置，`--` 结束选项；非法或重复 flag 及多余位置参数在创建输出前退出。不传 BASE 时自动在调用目录创建唯一目录，输出 `BASE_DIR=`。相对路径会在入口固定解析；审核 launcher 改变目录不会改变媒体和脚本指向。

doctor 与正式转录共用配置解析：非空环境变量 → `VOLCENGINE_ENV_FILE` → skill `.env` → 上一级 `.env`。文件允许空白和成对引号，值内部字节保留，不展开变量或命令；重复 key、占位符与非法 key 明确拒绝。doctor 每次显式执行检查当前配置和服务，HTTP 失败、缺少成功业务状态或未知错误不报告 ready。固定静音探测的极速版 `20000003` 只表示探测处理完成。`.setup_done` 保存资源能力，`doctor.js --json` 提供推荐参数；auto 单资源固定、双资源轮换，不能因大小超限转入已知不可用资源。

`invocation.json` 保留运行身份、状态和写入所有者；媒体 context、转录入口与 words/breaks 的归属在审核前校验。审核只写入当前 `BASE/3_审核`，生成时使用排他锁，异常遗留锁不会自动接管。详细步骤及产物说明见 [`SKILL.md`](SKILL.md)。

### 当前媒体与时间边界

- 支持 MP3、M4A、WAV，以及 **CFR** 的 MP4、M4V、MOV；素材必须恰好有一条主音轨。
- MP3/M4A 携带封面仍按音频处理，多个真正主视频流仍拒绝。浏览器审核另行检查加载、画面与定位能力；当前视频审核仅验证 H.264/AAC 组合，其他 codec、探测超时或解码失败会明确拒绝，不自动转码。
- 当前仅支持有效 presentation start 为 0、时间戳连续单调且播放速率为 1 的素材。
- CFR 视频的实际视频帧终点与主音轨终点必须在一帧容差内一致。
- 检测到 VFR 时会在任何网络调用前停止，并提示：`仅支持 CFR，请先转码为 CFR 后重新执行`。
- 每种输入都先生成 48 kHz、单声道、64 kbps CBR 的一次性审核音频；审核时长只由解码 PCM sample count 决定。
- FCPXML 引用原始资产而不是审核音频。音频按源采样网格量化，视频按 CFR 帧网格量化。

### 模式 A:剪口播(主线)

直接说「**帮我剪这个口播音频 /path/to/audio.wav**」或提供视频路径,选 A。agent 会:

1. 先通过媒体硬闸门并生成统一 `review_audio.mp3`，再把审核音频送火山引擎转录成字级字幕
2. 通读全文,标出口误 / 口癖 / 残句,**预选**好要删的片段
3. 起一个**本地审核网页**,你在波形和逐字稿上增删、调起止留白
4. 满意后点 **「导出 FCPXML」**；默认勾选的「可编辑标题字幕」会一并导出 Final Cut Pro Title，不需要字幕时取消勾选即可
5. 把生成的 `*_cut.fcpxml` 拖进剪辑软件,完成最终剪辑:
   - **剪映专业版**:文件 → 导入 → Final Cut Pro XML
   - **Final Cut Pro**:双击 `.fcpxml` 即导入

> 💡 导出后会得到 `learning_diff.json`。如需学习，请在当前或新会话中**显式提供这个仍存在的文件路径**并说「学一下」。agent 会先读取既有规则、列出候选，等你确认后才修改长期经验规则；不会自动扫描历史输出，也不读取旧格式。

### 模式 B:转字幕

说「**把这个视频或音频转成字幕**」,选 B。agent 会转录 → 纠错(同音错字、专有名词)→ 自然断行,输出一份规范的字幕文本 `subtitles_formatted.md`(简体中文、每行不长、无时间戳),可直接拿去用。

## 依赖要求

- 一个支持 skill、有文件系统访问、能跑 shell 命令的 coding agent(不绑定特定工具)
- `node` · `python3` · `ffmpeg` · `ffprobe` · `curl`(自检脚本 `doctor.js` 会按平台给安装命令)
- 一个[火山引擎](https://console.volcengine.com/speech/new/overview)账号(语音转录用,有免费额度)

想了解内部流程(步骤 0-8、两模式的脚本管线),看 [`SKILL.md`](SKILL.md) —— 它是整个 skill 的唯一入口和工作流地图。

## 隐私

`.env`(你的 key)被 `.gitignore` 忽略,不会进仓库。统一生成的审核音频以 base64 发送给火山引擎转录，不经任何第三方图床；原始视频文件不上云。

## 验收边界

仓库自动测试覆盖媒体硬闸门、sample clock、PCM 静音、编辑状态、整数 `compiledCutPlan`、浏览器状态机、FCPXML/XML DTD 和当前 `learning_diff` 格式。第一次真实使用仍需由用户分别用 MP3、M4A、WAV、CFR 视频核对开头/中段/结尾的 ASR、文字、波形与声音位置，并在 Final Cut Pro 中实际导入音频/视频 FCPXML 和可编辑标题；完成这些人工验收前，不作产品级最终通过承诺。

## 致谢

由 **栗氪聊AI** 创建。

## License

[AGPL-3.0](LICENSE) — 自由使用、修改、分发；但**任何修改版都必须同样以 AGPL-3.0 开源，包括把它做成网页 / 在线服务对外提供时也要公开你的改动源码**。

**显著修改说明：** 2026-08-30 重构为统一审核音频与 sample-domain 时间模型，新增 CFR/零起点硬闸门、PCM 静音证据、唯一整数 `compiledCutPlan`、原始资产 FCPXML 渲染和当前格式 `learning_diff`；用户真实素材与 Final Cut Pro 验收仍保留为人工闸门。

Copyright © 2026 栗氪聊AI
