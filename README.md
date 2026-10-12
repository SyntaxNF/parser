# snf-parser

SNF（Syntax Normal Form）模板解析与编译库，将 `.snf` 文档或语法片段转换为可直接消费的 AST。适合语法编辑器、表单和 SQL 生成器读取模板中的输入槽位、可选项、候选分支与重复结构。

输入是描述语法的 SNF 模板。一次 `parse()` 完成本地定义展开、循环成员绑定、递归引用解析、缩进归一和节点 UID / 名称分配。SQL 文本的解析、生成和执行由消费方实现。

## 安装

```sh
pnpm add snf-parser
```

本包提供 ESM 与 TypeScript 类型声明，使用 `import` 接入。

## 使用

### 完整文档

使用 `SNFDocumentParser` 解析带定义指令的模板：

```ts
import { SNFDocumentParser } from 'snf-parser';

const source = `
# CASE NORMAL
SELECT column_definition [, ...] [ LIMIT count ]

# WHERE column_definition
column [ AS col_alias ]
`;

const document = new SNFDocumentParser().parse(source);
const entry = document.entries.find(item => item.name === 'NORMAL');
console.log(entry?.ast); // column_definition 已展开，LOOP 已绑定完整成员
```

读取文件时，先由调用方加载文本，再交给 parser：

```ts
import { readFile } from 'node:fs/promises';
import { SNFDocumentParser } from 'snf-parser';

const source = await readFile('/path/to/template.snf', 'utf8');
const document = new SNFDocumentParser().parse(source);
```

### 独立片段

没有文档指令的片段使用 `SNFParser`，直接返回根 AST：

```ts
import { SNFParser } from 'snf-parser';

const ast = new SNFParser().parse('ORDER BY column [, ...]');
```

### 精简输出

只需要运行时结构时，两个入口都支持 `{ simple: true }`：

```ts
const document = new SNFDocumentParser().parse(source, { simple: true });
const json = JSON.stringify(document);
```

精简模式移除源码、位置和容器中重复保存的模板文本，保留结构、叶子文本、UID、名称、缩进与递归目标。默认模式保留完整来源信息，适合编辑器和诊断。TypeScript 会按选项返回相应类型。

## 解析结果

| 接口 / 字段 | 内容 |
| --- | --- |
| `SNFDocumentParser.parse()` | 返回完整 `SNFDocument`，或精简的 `SimpleSNFDocument` |
| `SNFParser.parse()` | 返回根 `Node`，或精简的 `SimpleNode` |
| `document.entries` | 顶层入口；包含可选名称、依赖与最终 AST |
| `document.definitions` | 本地定义；包含种类、别名、依赖、递归标记与最终 AST |
| `document.content`、`lines`、`blocks` | 完整模式下的源码与定位信息；`blocks` 只保留源码，不包含 AST |

消费方通过 `NodeType` 区分节点，从 `children` 读取结构，从叶子 `content` 读取文本。`LOOP.separator` 保存重复分隔符，`QUOTED.quote` 保存引号类型，递归 `REFERENCE.target` 指向定义根 UID。全部最终节点带有 UID，动态节点同时带有名称；同一文档内 UID 唯一，名称允许重复。每次解析使用独立会话，跨文档关联时需同时保存文档标识。

本地定义已经编译，消费方无需再次展开。`STATEMENT` 只保留名称和类别标签；跨文件模板加载、输入值、候选选择、可选项开关与循环次数由消费方管理。

## SNF 与生成约定

[SNF 语法与 AST 参考](docs/snf-reference.md)统一说明记号、`CASE` / `WHERE` 等指令、递归、精简模式、源码位置、缩进及生成时的空格规则。循环表示完整成员的零次或多次重复；具体 SQL 的必填项与语义约束由消费方处理。

节点 UID 的编码、稳定性边界和碰撞诊断见 [稳定 ID 设计](docs/snf-ast-stable-id-design.md)与 [UID 与名称](docs/snf-reference.md#uid-与名称)。需要检查局部特征重复时，可使用公开的 `findIdentityCollisions()`。

## SQL 模板仓库

模板按数据库版本单独维护，每个 `.snf` 文件链接对应的官方语法来源：

| 仓库 | 版本基线 |
| --- | --- |
| [MySQL](https://github.com/SyntaxNF/mysql) | MySQL 8.4 LTS |
| [PostgreSQL](https://github.com/SyntaxNF/postgresql) | PostgreSQL 18 |
| [Oracle](https://github.com/SyntaxNF/oracle) | Oracle Database 19c |
| [SQL Server](https://github.com/SyntaxNF/sqlserver) | SQL Server 2025（17.x），兼容级别 170 |

## 错误处理

语法或定义错误抛出 `SNFParseError`，提供 `offset`、`line`、`column` 和可选的 `expected`。完整文档的位置对应原始文档，片段的位置对应输入字符串：

```ts
import { SNFDocumentParser, SNFParseError } from 'snf-parser';

try {
  new SNFDocumentParser().parse(source);
} catch (error) {
  if (!(error instanceof SNFParseError)) throw error;
  console.error(`${error.line}:${error.column}`, error.message);
}
```

定义重名、非法指令、空候选和未闭合结构等错误会在解析时报告；展开超过 1,000,000 个节点时抛出 `RangeError`。

## 开发与检查

发布工作流使用 Node.js 24 和 pnpm 10。本地安装与构建：

```sh
pnpm install --frozen-lockfile
pnpm build
```

`build` 清理 `dist/` 后生成 ESM 与类型声明。源码入口为 [src/index.ts](src/index.ts)，完整文档编译流程从 [src/internal/compiler.ts](src/internal/compiler.ts)开始。

按需手动运行检查：

```sh
pnpm test
pnpm exec tsc --noEmit
```

`pnpm test` 包含解析、编译、UID、命名、缩进和真实模板回归。真实模板默认从同级 `../templates/<仓库名>/` 递归发现全部 `.snf` 文件，也可使用 `SNF_TEMPLATE_ROOT=/path/to/templates pnpm test` 指定模板根目录；目录不存在或没有模板时会失败。

| 命令 | 检查范围 |
| --- | --- |
| `pnpm test:uid` | UID 稳定性、容器特征与碰撞 |
| `pnpm test:name` | 动态节点命名 |
| `pnpm test:indent` | 相对缩进与 helper 排版 |
| `pnpm test:simple` | 真实模板精简前后的结构与运行字段 |
| `pnpm test:complex` | 真实模板的来源范围、引用、UID 与确定性 |

发布工作流检出四个模板仓库，完成测试和构建后发布。跨仓库检查遵守各模板仓库的 [AGENTS.md](https://github.com/SyntaxNF/postgresql/blob/main/AGENTS.md)要求。

## 许可证

[MIT](LICENSE)，Copyright (C) 2020-present, baskwind。
