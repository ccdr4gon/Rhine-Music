# 模型源文件

此目录保留 Blender 场景和对应建模脚本，用于维护与复现。正常运行播放器不需要安装 Blender；运行时资源位于 `public/assets/`。

- `music-case.blend` / `build_music_case.py`：当前音乐专辑盒，按运行尺寸 4.45 × 3.35 × 0.28 建模（厚度由脚本的 `DEPTH` 决定，盖板与背板各 32 mm，内层框条填满两者之间）。节点 extras.rhineLod 区分货架实例共用部件（shared）、货架替身（lod1）与抽出专辑的细节（lod0）；输出 `public/assets/music-case.glb` 并更新 `src/music-case-asset.ts` 的缓存版本。通过 Blender MCP 执行时须传入脚本的绝对 `__file__`（例如 `runpy.run_path`）；脚本在独立场景中建模，并只用 `bpy.data.libraries.write` 写出该场景，不保存界面或文件选择器路径。
- `music-cd.blend` / `build_music_cd.py`：此前的玻璃 CD 薄壳（V0.1.0–V0.3.0 初期，显示尺寸由前端运行时调整），仅作历史保留，运行时已不再使用。
- `rhine-archive.blend` / `build_archive.py`：保留的原版档案盒。
- `archive-assembly.blend` / `build_assembly.py`：原版拆解模型。
- 其余 `.py` 是共享结构、外壳和审阅场景脚本；生成的 `.blend1` 备份、`.cache/` 和审阅 PNG 不随发布分发。

## 发布前清理保存对话框元数据

Blender 场景可能保存文件选择器的本机目录。V0.1.0 的 `music-cd.blend` 已清空这类固定长度目录字段，并保存为正常的未压缩 `.blend`；模型、材质和场景数据均保持不变。清理证据见 [发布检查](../docs/RELEASE-V0.1.0.md)。

重新生成后，需再次检查源文件元数据。对于本项目已验证的 Blender 5.0.2 / `BLENDER17-01v0502` 文件，可运行：

```sh
python3 scripts/sanitize_blend_browser_metadata.py art/music-cd.blend art/music-cd.clean.blend
```

脚本仅修改 `FileSelectParams.dir` 数组，核对全部其余字节一致后写入新文件，不覆盖输入或已有输出。输入为 Zstandard 压缩文件时另需 `zstd` 命令；已解压文件只需 Python 标准库。其他 Blender 格式会明确拒绝，需要使用对应版本的 Blender 清理后复核，不能直接替换二进制字符串。

本目录非代码资源的许可边界见 [README](../README.md#开发与来源)，不要将代码许可自动扩展到所有模型素材。
