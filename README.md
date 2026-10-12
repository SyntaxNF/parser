# snf-parser

SNF（Syntax Normal Form）模板编译器。一次解析完成本地定义展开、枚举与引号容器构建、循环成员绑定，以及最终 AST 的 UID 和名称分配。

## 使用

本包只发布 ESM：`pnpm add snf-parser`。

```ts
import { SNFDocumentParser, SNFParser } from 'snf-parser';

const document = new SNFDocumentParser().parse(`
# CASE NORMAL
SELECT column_definition [, ...] [ LIMIT count ]

# WHERE column_definition
column [ AS col_alias ]
`);

const entry = document.entries[0];
console.log(entry.name); // NORMAL
console.log(entry.ast);  // 已展开 column_definition、绑定 LOOP，并生成 uid/name

// 无文档指令的独立片段也直接返回完成结构处理的 AST。
const fragment = new SNFParser().parse("ORDER BY 'column' [, ...]");
```

文档结果包含：

| 字段 | 内容 |
| --- | --- |
| `content`、`lines` | 完整源码、物理行、原始换行符和文档偏移 |
| `blocks` | 以空行分隔的源码块，包含 comment/content/lines 和位置；不包含 AST |
| `entries` | 顶层入口，每项包含可选 name、来源 blocks 索引、直接 dependencies 和最终 ast |
| `definitions` | 本地定义，每项包含 kind、names 别名、来源 blocks 索引、直接 dependencies、recursive 和最终 ast |

`entries` 与 `definitions` 的全部节点在同一文档内拥有唯一 UID。两个解析入口每次调用都创建独立会话，不依赖任何历史解析结果。

## 文档指令

| 指令 | 语义 |
| --- | --- |
| `# CASE NAME` | 命名顶层入口；一个 CASE 对应一个内容块 |
| `# WHERE name` | 一个内容块定义一个可复用片段 |
| `# ONEOFIS name` | 每个物理内容行一个候选，编译为 ENUM/GROUP |
| `# PARTOFIS name` | 每个空行分隔的内容块一个候选，编译为 ENUM/GROUP |
| `# STATEMENT name` | 保留为 STATEMENT 标识，内容行存入 categories，不解析或加载外部模板 |

CASE 名称使用大写字母、数字和下划线；定义名称使用小写字母、数字和下划线。定义支持逗号分隔别名，例如 `# WHERE item, other_item`。名称不能重复，允许前向引用。没有 CASE 的文档可以包含未命名入口；不能混用命名和未命名入口。声明前的普通注释和 URL 原样保留。

ONEOFIS/PARTOFIS 之后无新指令的内容块继续作为候选。CASE/WHERE 内容内部的换行不会切块，但空行会切块；后半段不能成为无主的延续块。普通说明注释不参与定义绑定。

与本地定义同名的 VARIABLE 会替换为 COLLECTION：`binding` 保留调用位置的名称与定义种类，`children` 包含展开后的定义内容。其余 VARIABLE 是输入槽位。循环先绑定完整前项，再展开其中的定义。

递归定义通过 REFERENCE 表达有限图；`target` 已解析为 `definitions` 中目标根节点的 UID。递归环内的定义仍完整编译，所有指向它们的引用均使用 REFERENCE。消费方可按 target 查找目标，无需再次按名称解析定义。实际递归次数由输入或生成策略决定。

STATEMENT 不参与递归或外部加载。引用它的节点带有 `name`、`binding` 和 `categories`，例如 `# STATEMENT query_statement` 配合 `SELECT` 得到名称 `query_statement`、类别 `['SELECT']`。类别作为不透明标签保留，允许声明没有类别。四库模板使用大写类别；MySQL 的泛化类别为 `SQL` / `COMPOUND`。

## SNF 记号与最终节点

| 记号 | 最终 AST |
| --- | --- |
| `KEYWORD` | DEFINITION，固定关键字 |
| `placeholder` | VARIABLE，或已绑定的 COLLECTION / REFERENCE / STATEMENT |
| `123` | NUMBER |
| `[ syntax ]` | OPTIONAL，直接包含整个可选序列 |
| `{ a \| b }` | ENUM，每个候选为一个非空 GROUP |
| `[ { a \| b } ]` | OPTIONAL 包含 ENUM |
| `item [, ...]` | LOOP，children 只有完整 item，separator 为 `,` |
| `item [...]` | LOOP，separator 为空串，生成时表示空白分隔 |
| `'text'`、`"text"` | QUOTED，quote 为定界符，children 保留内部语法与空白 |
| 空格 / 换行 | BLANK / WRAP，行内空白归一、行首相对缩进、行尾空白移除 |
| 圆括号、逗号等 | OTHER，SQL 字面符号 |

`[]` 仅表示可选，`{}` 仅表示枚举。未转义的 `|` 必须直接属于 `{}`，`[ A | B ]` 非法。反斜杠转义下一个字符，叶子 `content` 解码，`raw` 保留原始拼写。引号外行内空格和 Tab 的 BLANK.content 归一为一个空格，物理行尾（换行前或输入末尾）的 BLANK 从最终 AST 中移除。容器内首尾位置不等同于物理行首尾。空白行上的水平空白按行尾处理。归一化不改写源码、raw 或 start/end。

循环表示完整前项的零次或多次重复；支持变量、可选序列、枚举和完整引号序列。圆括号不是 SNF 分组，重复多字段成员应使用 helper 或 `{ ... }`。重复标记必须恰好包含一个末尾 `...`，分隔符只能包含固定描述。最终 AST 不保留 SPLIT、REPEAT 或孤立引号定界节点。

引号与 `[]`、`{}` 共用递归解析和闭合检查，内部按相同规则解析变量、可选项、枚举、循环和嵌套引号。每个容器必须独立闭合；需要作为普通字符输出的定界符使用反斜杠转义。SQL 成对转义引号（例如 `'IT''S'`）保留在同一个 QUOTED 内；循环可以重复整个引号序列。

引号内的小写占位符仍是输入，不自动变成固定文本。空字符串及文本空白保留原文，包括嵌套可选项、枚举和引号中的空白，避免改变字符串内容；这不影响统一的特征码规则。SQL 输出排版和尾逗号处理属于生成器。循环绑定和分隔符规范化在所有容器内使用相同规则：成员与重复标记之间的排版空白不作为重复内容，分隔符内部的排版空白规范化为一个空格并移除首尾空白；raw/start/end 不变。空白原文可通过源码和 raw 追溯，引号内外都不参与容器特征码，空白节点自身的 UID 也不使用其 content。

## 缩进

`indentLevel` 表示节点所在输出行的有效缩进，以四列为一层。行首及候选入口的 BLANK 锚点、引号外的内容/容器节点携带该字段；普通单词间的行内 BLANK 不携带。Tab 按四列制表位计算，非四列倍数的外部输入保留分数层级，不自动取整。字段不参与 UID 或功能特征。

- 每个入口、WHERE 定义、ONEOFIS 行或 PARTOFIS 候选去掉共同的前导空白，保留内部相对缩进。
- 仅包含 SNF 定界符及重复标记的行属于排版行，其额外缩进层会消除。同一物理行上的多个定界符只计算一次，不按 AST 深度累计。
- 含 SQL 内容的行保留其相对层级。`[ ( {` 中的 `(` 是 SQL 符号，因此其内部八格缩进保留；独占一行的 `{` 所增加的枚举排版层会消除。
- ENUM 各候选使用首个候选的入口排版和缩进基准，内部相对缩进仍保留。枚举关闭行的公共换行/缩进放到容器之后，避免仅最后一个候选拥有关闭行排版，或在 LOOP 内重复它。
- helper 在编译阶段按调用所在行的缩进重定位，首行接到调用位置，后续行叠加相对缩进；使用行的缩进，不使用占位符所在字符列。LOOP 每次重复使用相同的层级。
- SQL 括号、BEGIN/END 所表达的模板排版保留。引号内的文本空白原样保留，不做缩进换算。

生成器应以实际输出的行首节点 `indentLevel` 控制缩进，跳过未选 OPTIONAL、未选 GROUP 和零次 LOOP 产生的空行；不要再次累加已展开 COLLECTION 的父级缩进。递归 REFERENCE 的目标仍是局部定义，运行时展开须以引用节点的 indentLevel 为基准。输出文本来自叶子 `content`，而不是容器的原始 `raw/content`。必要的零缩进换行位置使用合成 BLANK 锚点，排版行上的 BLANK/WRAP.content 可以为空，原文仍可从源码和 raw 追溯。

## 源码位置

每个非合成节点的 `raw` 等于 `document.blocks[node.sourceBlock].content.slice(node.start, node.end)`。`start/end` 是零起点、左闭右开偏移。独立片段的 sourceBlock 为 0，偏移对应输入字符串。

定义展开后的子节点指向定义来源，COLLECTION 包裹节点指向引用来源，因此不能假设子节点的源码范围包含在父节点范围内。ONEOFIS/PARTOFIS 产生的根和 ENUM 标记 `synthetic: true`，没有单一源码范围（raw 为空、start/end 为 0）。LOOP 的范围包含完整前项和后缀标记，QUOTED 包含两侧引号。

合成 BLANK/WRAP 排版锚点也标记 synthetic，raw 为空，start/end 相等并指向插入位置；普通节点的源码范围不随排版移动或 helper 重定位而改变。

## UID 与名称

UID 格式为 `{类型码4位}-{深度4位}-{功能路径哈希32位}-{同前缀序号4位}`，版本为 `UID_V1`。哈希采用 UTF-8 SHA-256 的前 128 位。深度和序号取 `0000–FFFF`，溢出或检测到哈希碰撞明确报错。

类型码由 `UID_TYPE_CODES` 静态登记；前两位为类型缩写，后两位为缩写冲突的登记序号。COLLECTION 保留引用位置的 DEFINITION 功能标识，避免展开后丢失调用上下文。UID 在最终结构上生成，不包含变量名、helper/CASE 名称、源码位置、注释或推导出的 name。

QUOTED / OPTIONAL / GROUP 统一按直接子节点生成有序特征数组，再对其 JSON 编码做 SHA-256、对 `36⁴` 取模，得到 **4 位大写 Base36** 局部特征。所有 DEFINITION、NUMBER 保留完整内容，空白统一忽略，固定符号 OTHER、变量等其他类型只取类型名称首字母；类别标签防止固定文本与类型缩写混淆。QUOTED 子节点提供引号类型和已生成的四位特征，父节点不读取其 children。OPTIONAL / GROUP 等其他容器只提供类型，自身特征码参与自身 UID，不传递给父级。保留直接子节点顺序，不针对可交换参数列表排序。OTHER 叶子自身的 UID 仍使用 content，与引号外规则一致。

生成分两阶段：先用后序深度优先遍历计算局部特征，再用前序遍历结合父级路径分配 UID/name。两次遍历都使用显式栈，局部特征不依赖 UID、变量名或历史解析结果，也不作为中间字段写入 AST。例：`'Y'` 的特征 `[["D","Y"]]` 得到 `C4GQ`，父级遇到它只记录 `["Q","'","C4GQ"]`。

| 动态类型 | name |
| --- | --- |
| VARIABLE / REFERENCE / STATEMENT | 自身 content，保留大小写 |
| OPTIONAL | 第一个直接 DEFINITION / NUMBER / OTHER 的内容转大写；否则 OPTIONAL |
| ENUM / LOOP | 当前作用域连续 DEFINITION 关键字串，以 `_` 连接并转大写；否则 ENUM / LOOP |

同一上下文允许重名，UID 负责唯一性。DEFINITION 上下文按结构进出作用域，子结构继承、内部修改不泄漏，GROUP 相互隔离；每个入口和定义根重新开始。引号内关键字不改变外层上下文。

GROUP 不自动生成 name；OPTIONAL 的显示名称仍按上表获取，与用于 UID 的完整特征数组分开。

变量改名、普通排版变化、带不同功能标识的片段换序可以保持对应 UID。同前缀位置依靠序号区分，因此插入同前缀节点可能影响后续序号；新增实际包裹、修改关键字、引号或循环分隔符可以改变 UID。跨文档使用时还需携带文档标识。

通过 `findIdentityCollisions` 检查最终 AST 中 QUOTED / OPTIONAL / GROUP 的完整前缀重复：

```ts
import { findIdentityCollisions } from 'snf-parser';

const collisions = findIdentityCollisions(
  [...document.entries, ...document.definitions].map(item => item.ast),
);
// 片段也可以直接调用 findIdentityCollisions(fragment)。
for (const { kind, prefix, occurrences } of collisions) {
  console.log(kind, prefix, occurrences);
}
```

`short-hash` 表示当前节点不同的直接子级签名压成相同四位短码；`same-signature` 表示直接子级特征本就相同，仍需序号区分。QUOTED 碰撞可能使父级报告 same-signature，具体碰撞由 QUOTED 自身的 short-hash 报告定位。报告包含 UID、源码块、偏移、raw 和压缩前的直接子级 `fullSignature`；其中子 QUOTED 仍记录短码，不展开孙节点。

诊断只读，不改变解析结果。每次仅传入同一解析会话的根；同一根对象重复传入不会重复计数，缺失 UID 或不同节点对象具有完全相同 UID 则报输入错误。局部短码重复但上下文或节点类型不同，不会仅因此被报告。

完整编码、类型登记和稳定性边界见 [稳定 ID 设计](docs/snf-ast-stable-id-design.md)。

## 错误与开发

`SNFParseError` 提供 offset、line、column、expected。完整文档的错误位置对应原始文档（包括注释和原始换行）；片段错误对应片段输入。定义重名、非法指令参数、无主延续、空定义、空枚举候选和未闭合语法均会报错。完全展开超过 1,000,000 个节点时抛出 RangeError，防止定义展开失控。

代码按解析阶段组织，阅读完整文档流程可从 `src/internal/compiler.ts` 开始：

| 模块 | 职责 |
| --- | --- |
| `src/block.ts` / `src/file.ts` | 片段与完整文档的公开解析入口、物理行和源码块 |
| `src/internal/compiler.ts` | 串联编译、元数据分配和引用绑定 |
| `src/internal/productions.ts` | 声明收集、指令检查、内容树构建、源码错误定位与依赖收集 |
| `src/internal/syntax.ts` / `normalize.ts` | 基础记号与递归容器解析、完整循环成员绑定 |
| `src/internal/layout.ts` | 相对缩进、纯 SNF 排版层、候选公共边界和 helper 调用行基准 |
| `src/internal/definitions.ts` | 递归检测、本地定义展开和引用目标绑定 |
| `src/internal/identity.ts` / `definition-context.ts` / `hash.ts` | 功能标识与名称规则、作用域状态、UID 编码与哈希 |
| `src/internal/boundary-identity.ts` / `src/identity-collisions.ts` | QUOTED / OPTIONAL / GROUP 后序局部特征、短码碰撞与重复特征诊断 |

`Production` 表示已经具有语法树和依赖信息的内部定义，声明收集阶段单独使用 `Declaration`。对外仍只暴露完成编译的文档与节点。

```sh
pnpm test
pnpm test:uid
pnpm test:indent
pnpm exec tsc --noEmit
pnpm build
pnpm test:complex
```

`build` 清理 dist 后生成 ESM 与类型声明。单测覆盖完整编译、递归绑定、STATEMENT、引号与循环、命名与 UID 稳定性、真实四位容器短码碰撞和溢出。`test:uid` 包含三类节点的换序、插入、改名、直接子级边界、深层遍历与碰撞传播回归。`test:indent` 验证相对缩进、混合定界行、helper、重复项和四库真实模板的排版，并由 `test` 一并运行。`test:complex` 对同级四库全部 SNF 检查缩进层级、最终节点、来源范围、引用目标、UID 唯一性和重新解析确定性，同时汇总重复特征；四位短码导致完整前缀碰撞时测试失败并给出来源。遵守各库的验证授权要求。
