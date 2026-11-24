# engine/

这个目录用来放本地开源口型引擎（可选）。

插件默认的 `still` 引擎不需要它。只有当你选择「渲染引擎 → 本地开源口型」时才需要在这里准备服务。

## 推荐做法

运行预检脚本：

```powershell
powershell -ExecutionPolicy Bypass -File ..\scripts\install-engine.ps1
```

加 `-Clone -Target livetalking` 会把开源仓库拉到 `engine/third_party/`。

## 引擎需要实现的协议

```
GET  /health                        -> { ok, engine, gpu, fps, avatarReady }
POST /avatar   { image: dataUrl }   -> { avatarId }
POST /say      { avatarId, audio }  -> { jobId }
GET  /stream?avatarId=...           -> multipart/x-mixed-replace（MJPEG，1080×1920）
POST /reset    {}
```

只要能满足这个协议，MuseTalk、Wav2Lip、LiveTalking 或自研服务都可以接。

## 注意

- 本目录不包含、也不会自动下载任何模型权重，请按各开源项目的许可自行获取。
- 模型权重通常几百 MB 到 3GB，建议放在 `engine/third_party/<项目>/` 下。
- 6GB 显存建议 Wav2Lip；MuseTalk 需要 fp16 + 降 batch 才跑得动。