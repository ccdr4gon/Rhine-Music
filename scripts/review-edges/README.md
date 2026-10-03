# 动态细边缘对照

这个页面仅用于开发验证，不进入播放器安装包。它使用真实 `ArchiveScene`、演示封面和固定相机姿态，不读取个人曲库或播放音频。

先在仓库根目录准备修复前的源码快照，再启动 Vite：

```powershell
New-Item -ItemType Directory .tools -Force
git archive -o .tools/edge-baseline-source.zip d2de624 -- src content
Expand-Archive .tools/edge-baseline-source.zip .tools/edge-baseline -Force
npm.cmd run dev -- --port 5192 --strictPort
```

打开 `http://127.0.0.1:5192/scripts/review-edges/edge-review.html?comparison=all`，点击 Run。若此端口已占用，请更换端口，不要结束未知服务。

- 绘制缓冲固定 1280×720、有效 DPR=1，保留 original 的阴影、AO、景深和透射设置。
- checkpoint 四组分别为原样、4× MSAA、SMAA、二者叠加；current-product 使用当前产品的实际采样决策，不强制覆盖其 AA 参数。
- 每组 60 帧，默认每帧移动 0.1 屏幕像素。可分别检查详情／阵列、相机／盒体移动及静止对照。
- 直接读取最终 GPU 帧，在线性亮度上计算相邻三帧的二阶变化。每个主题的首个 baseline 生成边缘范围，后续组复用。该指标只是固定运动下的闪烁代理，不是感知画质分数，也不能取代原尺寸图像检查。
- 每帧通过 MessageChannel 让出；模拟步长保持 1/60。GPU 计时排除 disjoint，查询收尾有截止时间。同步读回会阻塞，不能把页面测量速度当作应用 FPS。
- 完成后可下载 JSON、全画面对照和 1:1 裁切。临时原始数据放在 `.tools/`，不要混入个人播放截图。

修改源码后刷新页面再测。当前页面会读取 TypeScript 编译后的内部字段；如果场景结构改名，需要同步维护。该页面不修改产品偏好。

## 逐像素闪烁热力图

`flicker-heatmap.html` 回答“哪里在闪”，不只给一个平均值。它同样使用真实 `ArchiveScene`、演示封面、original 画质和固定 1280×720，60 帧按 0.1 像素/帧移动，对每个像素统计线性亮度的平均二阶差，并输出首帧、热力图和连续 8 帧的 3× 裁切。`code=checkpoint` 读取 `.tools/subpixel-baseline/`，准备方式与上文相同，只需把 `d2de624` 换成要对照的提交（2026-10-01 的对照使用 Portable 基线 `6f86b3d`）。

```text
http://127.0.0.1:5192/scripts/review-edges/flicker-heatmap.html?code=current&theme=night&pose=archive
```

- `off=covers,ao,bokeh,shadow,model,array` 逐项隐藏来源，用于定位；`samples=` 覆盖场景多重采样数；`ss=2` 做 2×2 超采样对照；`crop=x,y,w,h` 选择裁切；`mode=gpu` 只测 40 个完整帧的 GPU 时间。
- `meanD2x1e4` 是全帧平均二阶差 ×10⁴；`hotFraction` 是二阶差超过 0.01 的像素比例，对应肉眼可见的忽亮忽暗。真实移动本身也会产生较低的二阶差，因此结果须与裁切一起看。
- 结果写入页面和 `window.__result`，可由无界面浏览器读取。它不修改偏好，也不读取个人曲库。
