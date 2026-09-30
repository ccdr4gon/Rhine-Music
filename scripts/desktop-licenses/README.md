# Rust 依赖补充许可

部分锁定版本的 crates.io 源码包没有随包许可证。这里保存其同一 Git 提交中的原文，获取地址见 `sources.json`，由 `scripts/desktop-resources.mjs` 合并到客户端 `web/licenses/rust-dependencies.txt`。更新对应依赖时应重新核对来源；未知缺失许可会使准备步骤失败。

- `alloc-stdlib`、`defmt-parser`、`lofty`、`lofty_attr`、`ogg_pager`、`webview2-com` 和 `webview2-com-macros`：原仓库、发布包 `.cargo_vcs_info.json` 对应的提交原文。`webview2-com-sys` 与 `webview2-com` 使用同一提交的仓库级 MIT 许可。
- `selectors 0.38.0`：源码头部和 Cargo.toml 均声明 MPL-2.0；`MPL-2.0.txt` 是同一依赖树中 `cssparser 0.37.0` 携带的标准完整文本。生成清单提供每个准确版本的原始源码下载地址；本项目没有修改这些 Rust 第三方源码。
- `ferrous-opencc 0.4.0` 和 `ferrous-opencc-compiler 0.4.0`：Cargo.toml 声明 Apache-2.0，上游提交未附 LICENSE 文件；准备脚本使用项目现有完整 `public/licenses/apache-2.0.txt`，保留包作者和源码地址。繁简字典来自 OpenCC，说明见项目 NOTICE。

准备步骤根据 Cargo 实际目标筛选依赖，再从应用根节点遍历正常和构建依赖，不纳入仅供测试的依赖。它保留包内 LICENSE、COPYING、NOTICE 等原文；不向清单写入本机 registry、用户名或工程目录。
