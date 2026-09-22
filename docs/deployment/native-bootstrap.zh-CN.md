# 原生依赖引导

此流程只适用于固定内网主机 `10.250.0.222`。它为 `baox` 服务账号建立独立 GCC、uv 管理的
Python 和构建虚拟环境；不会替换系统 GCC、glibc、`libstdc++` 或 `libgcc`。常规发布不会安装这些
依赖，`deploy --dry-run` 发现缺失时只会拒绝并报告原因。

先在维护人员本机确认 GitHub CLI 可以查询公开证明，再从仓库根目录运行预览：

```bash
pnpm --filter @baox/operator operator -- bootstrap-preview --proxy http://192.168.2.201:7890
```

预览会让主机解析实际的 dnf 事务，列出每个包，并输出确认摘要。只允许四个构建输入
`gmp-devel`、`mpfr-devel`、`libmpc-devel` 和 `isl-devel`。若解析出的直接项或依赖项会安装、移除、
升级、降级、重装或替换 GCC、glibc、`libstdc++` 或 `libgcc` 家族，预览仍会显示事务，但执行会被拒绝。

人工复核包名、NEVRA 和摘要后，使用预览给出的完整摘要执行：

```bash
pnpm --filter @baox/operator operator -- \
  bootstrap-apply --confirm <64-hex-确认摘要> --proxy http://192.168.2.201:7890
```

`bootstrap-apply` 会重新解析事务。摘要不同、受保护系统运行时出现在事务中、账号 home 不是
`/home/baox`、工件校验失败或 `baox` 账号无法完成 C++20/Python 探测时都会拒绝。没有 `--confirm`
或摘要格式不正确时，命令不会连接主机、上传工件或运行 dnf。

## 中继工件

无法让主机经代理下载时，先把下表所有文件放入维护人员本机的一个目录，再在两条命令上都加
`--relay <目录>`。中继目录中的文件先在本机按固定 SHA-256 核对；上传只能落到主机固定的
`/opt/tools/baox/operator-artifacts/<sha256>` 名称，不能指定远端路径。主机再次按相同固定摘要检查
每个文件，随后才会执行 dnf 事务。

```bash
pnpm --filter @baox/operator operator -- \
  bootstrap-preview --proxy http://192.168.2.201:7890 --relay /secure/baox-bootstrap

pnpm --filter @baox/operator operator -- \
  bootstrap-apply --confirm <64-hex-确认摘要> \
  --proxy http://192.168.2.201:7890 --relay /secure/baox-bootstrap
```

`--proxy` 只能是没有用户名、密码、查询参数或片段的 HTTP/HTTPS 地址。命令输出会遮盖凭据；不要把
带凭据的代理 URL 放入命令行或 `build.env`。

## 工件证明

| 工件 | 固定来源和主机检查 | 证明边界 |
| --- | --- | --- |
| `gcc-12.5.0.tar.xz` | GNU 发布页；SHA-256 `71cd373d0f04615e66c5b5b14d49c1a4c1a08efa7b30625cd240b11bab4062b3`、SHA-512 `c76020e4c844b53485502cb8a4e295221c9d37487d66c9f4559031fb14c85de20602e6387310005386cb0ef25e55067d2cfef141423bb445f3b77e7456a23533` | 主机使用固定 SHA-256 的 GNU keyring 和 `.sig`，以 `gpgv` 验证签名者指纹 `7F74F97C103468EE5D750B583AB00996FC26A641`。 |
| GCC `.sig` 与 `gnu-keyring.gpg` | SHA-256 分别为 `c5a0cfe77b541f5b694cca334a890d9c3a4aa1d3be67b1080ca002ceddc18cd2` 与 `b136fbe57ade4ee5270ca66c402cae7b50349fd07646b5b3de7962d58d4df608` | 中继和代理路径都在主机重复校验，不能把随工件带来的 keyring 当作信任根。 |
| `uv-x86_64-unknown-linux-gnu.tar.gz` 0.12.17 | GitHub release；SHA-256 `fa82fd8dde8e8eefdecada6aa0889666556cfceb690d06e0c3bca49eb3070a63` | 执行前，维护人员本机对完全相同的字节运行 GitHub Artifact Attestation 验证：仓库 `astral-sh/uv`、工作流 `astral-sh/uv/.github/workflows/release.yml`、源提交 `635500036e1705961315e86447f0fab0a8ddb309`、`refs/heads/main`，并拒绝自托管 runner。主机只重复固定 SHA-256 检查；uv 没有被当作带 GNU 分离签名的工件。 |
| CPython 3.12.14 x86_64 GNU | UV 已认证源码中的嵌入目录指定 `cpython-3.12.14+20260901-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz`，SHA-256 `72748da13197c1fb161e3afeef20a6a385ff24f2165e6e2758e47008e7faba4c` | 主机在代理和中继路径都校验该摘要，将它放入受控 UV 缓存，并以 `uv --offline python install` 使用它。这里的认证链来自已验证的 UV 发布和其目录；不要把它描述成 CPython 分离签名验证。 |

代理模式中，维护人员本机先通过声明的代理下载并验证 uv；主机随后通过同一代理重新下载固定 URL 并检查摘要。
中继模式中，本机对待上传的 uv 字节执行相同证明验证，主机再检查上传后的字节。两种路径因此都绑定到同一
uv 摘要，且主机始终自行拒绝错误摘要。

## 结果和边界

成功后，GCC 只位于 `/opt/tools/baox/runtime/gcc-12.5.0`；uv、受管 Python 和构建 venv 只位于
`/home/baox/.local`。`/opt/tools/baox/etc/build.env` 是 root 所有、`0600` 的受控环境文件，目前只写入
`HTTP_PROXY`、`HTTPS_PROXY` 和 `NO_PROXY`。引导以 `runuser -u baox env -i` 完成编译器和 Python 的
就绪探测，包含 C++20 编译探测。

旧的 `deploy/intranet/install.sh` 是首次采用或受控修复的历史路径，不能作为常规升级入口。常规发布、候选
构建和切换必须先通过维护闸门和各自的预检；它们不得借由引导路径安装或升级原生系统运行时。
