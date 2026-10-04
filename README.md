# speech-roughcut

一个支持**口播视频和纯音频**的 coding-agent skill：自动转录 → AI 口误／口癖建议与停顿候选 → 网页波形审核 → 导出 FCPXML，交给剪辑软件完成精剪。核心是一份 [`SKILL.md`](SKILL.md)，**任何支持 skill、能读文件、能跑 shell 的 coding agent 都能装来用**，不绑定特定工具。
> 这个项目灵感最初来源于GitHub开源项目 videocut-skills，为了适配我自己的剪辑工作流，重写和扩展了工程导出、前端交互、视频预览、核心剪辑逻辑、语音识别和音频识别字幕等功能

![审核页界面](assets/review-ui.png)

> 审核网页：点击文字即试听，划选文字删／恢复；Shift 拖选波形或输入起止时间，试听后删除任意声音。自动音频建议可逐条调整、恢复，也可按类型或全部恢复；停顿标记可定位原声。满意后点「导出 FCPXML」。

## 这个 Skill 做什么

口播素材最费时的不是剪,是**找哪里该删** —— 重复重说、卡顿、口癖、长停顿。speech-roughcut 把这步交给 agent:转录全文、标出该删的片段,再起一个**本地审核网页**,让你对照声音、波形和逐字稿检查实际切点。

它**不直接改写原始媒体**,只把「哪里该删」想清楚,生成剪辑工程文件(FCPXML)交给剪辑软件做最后一刀。不使用第三方图床或临时云存储 —— 转写音频以 base64 直传火山引擎，其余处理都在本机完成。

### 主要特性

- **AI 预标口误** — 重复重说、残句、卡顿、纯语气词整句，预选后由你对照原声确认
- **统一审核时钟** — MP3、M4A、WAV 与 CFR MP4/M4V/MOV 都生成一次性 `review_audio.mp3`；播放器、波形、文字、标题和导出共同消费一份整数 `compiledCutPlan`
- **可调整的自动粗剪** — agent 根据每条录音的音频与转写提出区间建议，工作台可按单条、同类或全部恢复；ASR／PCM 检测证据仍独立，不直接生成删除
- **原始资产不改写** — 审核使用统一音频，FCPXML 始终引用原始音频或视频资产，并按音频采样网格或 CFR 视频帧网格生成时码
- **可编辑标题字幕** — 导出时默认把转写结果一并写成 Final Cut Pro Title；短行沿用工作台分行，长行按 14 个中文字宽度拆分，导入后可逐块改字和调整样式
- **经确认后学习偏好** — 导出生成一次 invocation 的 `learning_diff.json`；只有你明确要求学习并确认候选规则后，才会更新长期经验规则
- **本地审核、按需转写** — 原始视频文件不上云，当前火山实现上传统一审核音频；费用与赠送额度以账户实际权益为准，项目不保证免费时长

## 安装

把这个仓库地址发给你的 coding agent,说一句 **「装一下」**:

```text
https://github.com/heathermason0719/speech-roughcut
```

agent 会读 README,自己把它装到本地 skills 目录、配好环境、跑一遍自检,约 1 分钟。有文件系统权限的 agent 直接帮你装好;没有的话,也能在当前会话里照 [`SKILL.md`](SKILL.md) 直接跑一遍。

唯一需要你**亲自做**的一步:办一个**火山引擎 API Key**（语音转录用，需有可用资源与额度）。装的时候 agent 会引导你把 key 填进去。

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

Skill 工作流默认输出到 `~/Movies/ROUGHCUT-OutPut/时间_媒体名_UUID/speech-roughcut/`。每次正式新运行有独立 UUID；已用 BASE 不会被新的转录复用。恢复已有任务使用 `bash scripts/run_transcribe.sh --resume <BASE>`，不能同时更换媒体或引擎。

正式脚本支持 `bash scripts/run_transcribe.sh <媒体> [BASE] [--auto|--flash|--v3-standard]`，flag 可在任意位置，`--` 结束选项；非法或重复 flag 及多余位置参数在创建输出前退出。不传 BASE 时自动在调用目录创建唯一目录，输出 `BASE_DIR=`。相对路径会在入口固定解析；审核 launcher 改变目录不会改变媒体和脚本指向。

doctor 与正式转录共用配置解析：非空环境变量 → `VOLCENGINE_ENV_FILE` → skill `.env` → 上一级 `.env`。文件允许空白和成对引号，值内部字节保留，不展开变量或命令；重复 key、占位符与非法 key 明确拒绝。doctor 每次显式执行检查当前配置和服务，HTTP 失败、缺少成功业务状态或未知错误不报告 ready。固定静音探测的极速版 `20000003` 只表示探测处理完成。`.setup_done` 保存资源能力，`doctor.js --json` 提供推荐参数；auto 单资源固定、双资源轮换，不能因大小超限转入已知不可用资源。

`invocation.json` 保留运行身份、状态和写入所有者；媒体 context、转录入口与 words/breaks 的归属在审核前校验。审核只写入当前 `BASE/3_审核`，生成时使用排他锁，异常遗留锁不会自动接管。详细步骤及产物说明见 [`SKILL.md`](SKILL.md)。

异步任务先持久化请求 ID，再提交；超时、网络不确定或本地进程退出后，显式 resume 只查询原任务，不重复 submit。合法 raw result 保存在 `1_转录/.asr/`，本地处理失败后可无凭证重放。极速版结果不确定且没有 raw 时无法查询，必须由用户决定是否发起新 invocation。完整 canonical `transcript.json`、words/breaks、raw 和身份凭据一起发布；失败产物不进入审核，已有成功不覆盖。英文、混合语言的显示分隔附着于真实 timed word，不生成虚构时间；非空识别缺少可表达 words 会明确失败。

### 当前媒体与时间边界

- 支持 MP3、M4A、WAV，以及 **CFR** 的 MP4、M4V、MOV；素材必须恰好有一条主音轨。
- MP3/M4A 携带封面仍按音频处理，多个真正主视频流仍拒绝。浏览器审核另行检查加载、画面与定位能力；当前视频审核仅验证 H.264/AAC 组合，其他 codec、探测超时或解码失败会明确拒绝，不自动转码。
- 当前仅支持有效 presentation start 为 0、时间戳连续单调且播放速率为 1 的素材。
- CFR 视频的实际视频帧终点与主音轨终点必须在一帧容差内一致。
- 检测到 VFR 时会在任何网络调用前停止，并提示：`仅支持 CFR，请先转码为 CFR 后重新执行`。
- 每种输入都先生成 48 kHz、单声道、64 kbps CBR 的一次性审核音频；审核时长只由解码 PCM sample count 决定。
- FCPXML 引用原始资产而不是审核音频。音频按源采样网格量化，视频按 CFR 帧网格量化。

时间审计按不同时间事实分别验收：packet/container 时长不替代有效解码 sample count；encoder delay/discard padding 不直接作为固定 offset。源与审核音频的首／中／尾残差需分别测量，误差随时长增长时不能用固定 offset 补偿。源网格末端由审核 samples 向外取整，可能比原生解码终点多出重采样与网格量化余量；不得仅因该差值修改时长或截断音频。

Title 的工作台预览和 compiled plan 保留原时间：消除所属 keep 的累计输出平移后，每个入／出点的源网格误差不超过 `1 个源 tick + 0.5 个 review sample`（44.1 kHz 约 33.1 μs；30000/1001 fps 约 33.3771 ms）。音频 cut、内容长度和 CFR Title 到 XML 仍零 tick 差异；极短音频区间继续由浏览器和导出共同消费最终 keep/cut。

音频 FCPXML 使用整帧 Primary Storyline `gap` 承载时间结构，真实音频以 `lane=-1` 连接在其下；`offset` 换算到 carrier 本地时钟，source start、duration 和实际 output 时间逐 sample 保持。`gap.start=3600s` 仅是 XML 本地坐标原点，不是媒体／ASR offset。carrier 与 sequence 时长向上取 30 fps 整帧，末尾小于一帧（33.333 ms）的全零承载余量已接受，不计入音频内容长度，不为消除它改变音频剪口。

音频工程的 Title 以 `lane=1` 连接到同一个 carrier，不能继续挂在 sample-grid 音频片段下。Title output 入出点取最近帧（半帧向后），并约束在所属 keep 内的完整帧范围，再换算为 carrier offset；因此局部 offset、duration 与最终 output 都在 edit-frame grid。相对 compiled plan，每端通常至多移动半帧，边界约束时严格小于一帧；duration 差异严格小于两帧。review 预览总误差另加前述 source 网格误差。量化后没有正长度整帧 Title 时明确拒绝带标题导出，不静默删字、越过剪口或改动音频。CFR 视频仍沿用原来的片段／嵌套 Title 路径。

Phase 4 的真实 MP3 三段候选已完成无警告、音频连续、Title 外观／可编辑性验收；回写逐 sample／frame 保留，带／不带 Title 的 WAV 解码 PCM 完全相同。旧的 Primary Storyline 音频帧化和插入一帧静音已由 connected audio 结构解决；历史负字距在独立复验中未复现，未添加字距补丁。FCP 与 ffmpeg 在该 MP3 的声学对齐仍有共同的 −1057 sample 差异，来源未定，不据此更改正式 offset，也不将局部真机结果扩张为所有格式的绝对声学等价。正式 renderer 生成物已完成最终 FCP 回写与人工冒烟确认：音频 sample、Title 帧位置／文字／样式保持，Phase 4 在上述已说明范围内闭环。

### 模式 A:剪口播(主线)

直接说「**帮我剪这个口播音频 /path/to/audio.wav**」或提供视频路径,选 A。agent 会:

1. 先通过媒体硬闸门并生成统一 `review_audio.mp3`，再把审核音频送火山引擎转录成字级字幕
2. 通读全文,标出口误 / 口癖 / 残句,**预选**好要删的片段
3. 起一个**本地审核网页**，你在逐字稿上审核建议，并在波形上试听、选择和删除声音范围
4. 满意后点 **「导出 FCPXML」**；默认勾选的「可编辑标题字幕」会一并导出 Final Cut Pro Title，不需要字幕时取消勾选即可
5. 把生成的 `*_cut.fcpxml` 拖进剪辑软件,完成最终剪辑:
   - **剪映专业版**:文件 → 导入 → Final Cut Pro XML
   - **Final Cut Pro**:双击 `.fcpxml` 即导入

新审核会话使用 `narration-v1`：执行当前录音已准备的音频区间建议，并保留词级审核与独立手工范围。约 ≥0.7 秒的无词停顿、咳嗽或长呼吸是重点检查对象；短停顿结合音频和上下文判断，自然句子优先连贯，句内过长停顿也可缩短。0.7 秒不作为全片自动删音开关。整句或半句完整删除时，准备建议须把删后接缝两侧剩余空隙一起评估，按语流缩短多余停顿；额外删音仍以可独立恢复的音频建议表达，不改变词级编译边界。每份音频建议有稳定 ID、分组、理由、依据及输入身份，可逐条改边界、恢复，同类或全部暂停，不撤销独立手工和词级决定。偶发且可恢复的局部瑕疵留给审核；同类规则造成全片反复损伤不算可交付。

ASR／PCM 检测与显示筛选不直接删音。连续删词覆盖首末词及内部间隙，不额外吞掉正长度保留区间；词级删除避开保留词，明确修改的音频范围优先。初始音频建议必须位于真实 word 时间之外，拒绝把跨词检测框直接当删音区间。旧 `conservative-v1` 保持仅词级／手工删除；无版本历史按 `legacy-v1` 复现 PCM／padding 行为，不静默迁移旧页面。

正文用轻量标记定位停顿，默认显示 ≥0.7 秒候选，可展开短候选；已编辑范围始终可见。显示边界为 `ceil(reviewSampleRate × 700 / 1000)` 个 samples，不控制删除。波形定位与连续播放会将对应正文滚入可见区域；无词空档显示最近上下文，不伪造当前词，不改变焦点或播放时间。范围输入支持秒数或分:秒（最多六位小数），内部换算为整数 review samples；试听、草稿选区和显示筛选均不提交删音。Space 固定控制播放／暂停；I／O 设置选区起止点，Delete（含 Mac 退格键）应用有效范围，按住不连发。时间输入中的 Delete／Backspace 仍编辑数字；输入法组合与系统修饰键不抢占。Cmd/Ctrl+Z 撤销，重做保持范围身份；编译失败保留上一次合法决定。正常暂停取消播放请求不会锁住页面，实际媒体故障仍拒绝继续。页面进入后台暂停，返回前台需手动继续。

每次成功导出保存到 `3_审核/exports/<revision>/`，该目录中的 FCPXML、`learning_diff.json`、`edit_snapshot.json` 和下载结果属于同一版本，后续导出不覆盖它们。同一审核目录只允许一个服务持有写入锁，进程退出后自动释放。临时读写或下载错误可重试；媒体身份、转录或冻结审核／PCM 数据发生变化时明确拒绝。新快照保存策略、完整编辑状态、输入 hash 和编译输入，服务端以同一编译器校验计划后保存；旧页面只提交计划时标为 `plan-only`，不冒充完整历史。快照可离线重放，不提供 autosave 或重开工程界面。 经核验输入身份与计划一致后，可将完整快照的编辑状态显式写入审核数据 `restoredEditState` 作为启动起点；保留词决定和范围 ID，不恢复旧 undo 历史。刷新会回到准备好的起点，新编辑需先导出留存。

> 💡 导出后会得到 `learning_diff.json`。如需学习，请在当前或新会话中**显式提供这个仍存在的文件路径**并说「学一下」。agent 会先读取既有规则、列出候选，等你确认后才修改长期经验规则；不会自动扫描历史输出，也不读取旧格式。

### 模式 B:转字幕

说「**把这个视频或音频转成字幕**」,选 B。agent 会转录 → 纠错(同音错字、专有名词)→ 自然断行,输出一份规范的字幕文本 `subtitles_formatted.md`(简体中文、每行不长、无时间戳),可直接拿去用。

## 依赖要求

- 一个支持 skill、有文件系统访问、能跑 shell 命令的 coding agent(不绑定特定工具)
- `node` · `python3` · `ffmpeg` · `ffprobe` · `curl`(自检脚本 `doctor.js` 会按平台给安装命令)
- 一个有可用语音识别资源与额度的[火山引擎](https://console.volcengine.com/speech/new/overview)账号

想了解内部流程(步骤 0-8、两模式的脚本管线),看 [`SKILL.md`](SKILL.md) —— 它是整个 skill 的唯一入口和工作流地图。

## 隐私

`.env`(你的 key)被 `.gitignore` 忽略,不会进仓库。统一生成的审核音频以 base64 发送给火山引擎转录，不经任何第三方图床；原始视频文件不上云。

## 验收边界

工程支持和自动回归不构成产品级最终通过承诺。当前 48 kHz 录音已获用户确认：剪辑效果达到本轮需求，FCP 导入正常。2026-09-16 已核对用户直接采用初始建议导出的 112 段版本：FCP 回写音频 source/output 逐 sample 保持，267 个 Title 时间、文字、字体和位置保持；音频内容 592.194895833 秒、项目承载 592.2 秒，尾部余量约 5.104 毫秒。此回写对应 revision `5f11cf59-68d7-429c-b092-9c718d3d5d61`，不冒充此前 107 段人工调整版的回写。自动核验、人工声音验收和回写证据分别记录。

能力声明按证据层级区分：

| 层级 | 当前证据与限制 |
|---|---|
| 工程支持 | 媒体硬闸门允许前述音频格式及 CFR 视频；通过准入不等于该素材已完成真实生产验收。 |
| 自动回归 | Phase 1～4 的 235 项回归通过，覆盖 invocation/ownership、媒体、可恢复转录、canonical transcript、PCM/edit state、playback、export revision、connected audio/Title 和 learning diff。 |
| 真实音频／FCP | Phase 4 已完成真实 MP3 三段剪辑的回写、PCM 和可编辑 Title 验收；当前真实 48 kHz 录音的粗剪效果与 FCP 导入已获用户验收，112 段初始建议版的 FCP 回写逐 sample 核对通过。本轮未追加 FCP WAV 声学比较。 |
| 视频 | 保留自动工程验证；未完成真实视频生产级验收，当前不把它作为音频主线封板条件。 |
| Provider | 当前真实实现为火山引擎；fake-provider/canonical 回归证明分析、审核和剪辑核心不依赖其 raw schema。未接入第二家真实 provider。 |
| 时长／容量 | 脚本内的 provider 路由上限只是当前实现的准入阈值，不是 speech-roughcut 已生产验证的时长；未验证 30/60 分钟压力或 2～5 小时极限。 |

`narration-v1` 消费 agent 为当前录音准备的 `audio_suggestions.json`（生成命令的可选最后参数，接口见 SKILL 第 5.7 节）。未提供建议时明确显示为空，不从检测阈值推造决定。没有 VAD、响度归一化或自动咳嗽识别；音频建议和人工调整均不改词级 learning。learning diff 只记录有效的词级语言决定，不学习 PCM、padding 或时间参数；长期偏好文件只在显式学习与规则确认后修改。

不提供审核 autosave／长期工程数据库、VFR、多音轨、通用视频代理、批处理或新增字幕交换格式。DTD/XML 通过不能代替 FCP 真机验收；声音对齐和 provider timing 的结论限于对应素材与证据，不自动升级其他输入的验证状态。

## 致谢

由 **栗氪聊AI** 创建。

## License

[AGPL-3.0](LICENSE) — 自由使用、修改、分发；但**任何修改版都必须同样以 AGPL-3.0 开源，包括把它做成网页 / 在线服务对外提供时也要公开你的改动源码**。

**显著修改说明：** 2026-08-30 重构为统一审核音频与 sample-domain 时间模型，新增 CFR/零起点硬闸门、PCM 静音证据、唯一整数 `compiledCutPlan`、原始资产 FCPXML 渲染和当前格式 `learning_diff`；用户真实素材与 Final Cut Pro 验收仍保留为人工闸门。

Copyright © 2026 栗氪聊AI
