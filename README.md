# snf-parser

`snf-parser` 用于解析 SNF（Syntax Normal Form）文档的物理结构和内容块语法。

解析器忠实保留当前文档的源码、物理行、Block 顺序和单块 AST，但不会解释注释的业务语义，不会解析跨 Block 引用，也不会把多个 Block 拼接成全局语法定义。调用方可以通过 Walker 在原始解析结果之上实现自己的指令、名称绑定和逻辑模型。

## 安装

```bash
pnpm add snf-parser
```

本包只发布 ESM。

## 解析内容块

`SNFParser` 解析一段不包含文档注释和空行分块逻辑的 SNF 内容：

```ts
import { NodeType, SNFParser } from 'snf-parser';

const parser = new SNFParser();
const ast = parser.parse('CREATE [ TEMPORARY ] TABLE name');

console.log(ast.type === NodeType.ROOT); // true
console.log(ast.raw);                    // 原始输入
```

## 解析完整文档

`SNFDocumentParser` 按空行划分 Block，并为每个 Block 解析独立 AST：

```ts
import { SNFDocumentParser } from 'snf-parser';

const source = `# https://example.com/create-table

# CASE NORMAL
CREATE TABLE name

# WHERE name
identifier`;

const document = new SNFDocumentParser().parse(source);

console.log(document.content === source); // true
console.log(document.blocks.length);      // 3
console.log(document.blocks[1].comment);  // # CASE NORMAL
```

注释始终是不透明文本。上例中的 `CASE` 和 `WHERE` 不属于 parser 内置语法，parser 不会根据它们修改 AST。

`SNFDocumentParser.parse(source)` 同步返回包含完整源码的文档对象，通过 `document.blocks` 获取内容块。

## SNF 基础记号

| 记号 | AST 节点 | 含义 |
| --- | --- | --- |
| `KEYWORD` | `DEFINITION` | 大写字母开头，由大写字母、数字和下划线组成。 |
| `placeholder` | `VARIABLE` | 小写字母开头，由小写字母、数字和下划线组成。 |
| `123` | `NUMBER` | 以数字开头的数字字面量。 |
| `[ syntax ]` | `OPTIONAL` | 整个内容可选。 |
| `{ a \| b }` | `ENUM` | 从候选 Group 中选择一个。 |
| `[ { a \| b } ]` | `OPTIONAL`、`ENUM` | 可选的显式枚举。 |
| `syntax [...]` | `LOOP`、`REPEAT` | 前面的语法可以重复；重复标记必须恰好是 `...`。 |
| `\|` | `SPLIT` | 仅在显式 `{}` 的当前层级分隔候选，解析后划分为 Group。 |
| 空格、Tab | `BLANK` | 水平空白。 |
| 换行 | `WRAP` | 内容块内部的换行。 |
| `'`、`"` | `QUOTE`、`DOUBLEQUOTE` | 原样保留的引号字符。 |
| 其他符号 | `OTHER` | 圆括号、逗号、点号和运算符等符号。 |

反斜杠用于转义下一个字符。叶子节点的 `content` 保存解码后的内容，`raw` 保留原始输入：

```ts
new SNFParser().parse(String.raw`value\|part`);
```

`[]` 只表示可选序列，不自动增加 ENUM 或 GROUP；只有显式 `{}` 才创建枚举，单候选 `{ value }` 也保留 ENUM 和 GROUP。未转义的 `|` 必须直接属于 `{}`，因此 `[ A | B ]`、`A | B` 和 `{ [ A | B ] }` 都会抛出 `SNFParseError`。可选枚举应写为：

```snf
[ { ASC | DESC } ]
```

`Node.name` 由调用方附加，或通过名称 Walker 推导；parser 不从语法中提取命名元数据。

## 文档结构

一个非空物理行如果从第一个字符开始就是 `#`，该行会被标记为 `COMMENT`；其他非空行标记为 `CONTENT`。空行结束当前 Block，但 parser 不解释 Block 之间的关系。

```ts
interface SNFDocument {
  type: 'document';
  content: string; // 完整原始文档
  lines: DocumentLine[];
  blocks: Block[];
}

interface Block {
  comment: string;
  content: string;
  ast: Node;
  lines: DocumentLine[];
  start: number;
  end: number;
  startLine: number;
  endLine: number;
}
```

`DocumentLine` 使用 `COMMENT`、`CONTENT` 或 `BLANK` 标记每一行，并保留原始换行符和文档偏移，因此调用方可以在不解释注释语义的前提下还原完整文档结构。`Block.comment` 和 `Block.content` 是方便使用的标准化视图，多行之间统一使用 `\n` 连接。

## AST 节点

```ts
interface Node {
  type: NodeType;
  content: string;
  raw: string;
  start: number;
  end: number;
  children?: Node[];
  name?: string;
  ast?: Node | Node[]; // Walker 保留的辅助子树
  quote?: "'" | '"';
  uid?: string;
}
```

- `raw` 是该节点对应的准确源码；结构节点包含自身的 `[]` 或 `{}`。
- `content` 是解析后的节点内容；结构节点不包含外层定界符，转义后的叶子节点不包含反斜杠。
- `start` 和 `end` 是相对于当前 Block `content` 的零起点、左闭右开偏移。
- `GROUP` 表示一个枚举候选，包括空候选，因此候选数量始终与源码结构一致。
- Parser 生成的每个节点都会提供 `raw`、`start` 和 `end`。

## Walker

Walker 不修改输入 AST，而是返回新树。回调中的 `parent` 为真实父节点，根节点对应 `undefined`。`exchange` 默认在访问子节点前执行，`filter` 在转换完成后执行；根节点本身不会被删除。

```ts
import {
  cleanBlank,
  ExchangeType,
  NodeType,
  reduceBlocks,
  type Node,
  walk,
  walkDocument,
} from 'snf-parser';

const cleaned = walkDocument(document, cleanBlank);

const transformed = walk(ast, {
  includeRoot: true,
  exchangeType: ExchangeType.AFTER,
  exchange(node, parent, context) {
    console.log(context.index, context.key, context.ancestors);
    return node;
  },
  exchangeChildren(children, parent, context) {
    // 在成员完成转换后重排、合并或删除兄弟节点。
    return children;
  },
  filter(node) {
    return node.type !== NodeType.WRAP;
  },
});
```

`walk` 的扩展选项包括：

- `includeRoot`：让根节点也执行 `exchange` 和 `back`；根节点始终不会被 `filter` 删除。
- `exchangeType`：控制 `exchange` 在子节点之前、之后或两次执行。
- `exchangeChildren`：在一组子节点完成遍历和过滤后转换整个数组，适合 Loop、Quote 等兄弟结构。
- `childKeys`：指定需要遍历的子树属性，默认仅为 `['children']`；可加入 `'ast'`。
- `context`：节点回调的第三个参数，提供 `parent`、`index`、`siblings`、`ancestors` 和 `key`。
- `back`：节点及其子树处理完毕后的离开回调，适合维护作用域栈。

包内置了一组可选的规范化 Walker，可以按需要组合：

```ts
import {
  addEnumName,
  addLoopName,
  cleanSingleBlank,
  createAddUid,
  exchangeLoopNode,
  exchangeQuoteNode,
} from 'snf-parser';

const addUid = createAddUid();
const normalized = addUid(
  exchangeQuoteNode(
    exchangeLoopNode(
      addLoopName(
        addEnumName(
          cleanSingleBlank(ast),
        ),
      ),
    ),
  ),
);
```

这些 Walker 只在显式调用后改变逻辑树，节点上的 `raw/start/end` 仍指向原始 SNF 来源：

- `cleanSingleBlank`：移除单字符分隔空白，保留多字符缩进；`cleanBlank` 则移除全部 `BLANK`。
- `addEnumName`：根据相邻关键字或第一个候选为未命名枚举推导名称。
- `addLoopName`：根据循环前的节点推导复数名称。
- `exchangeLoopNode`：把后缀重复结构转换成以被重复节点为 children 的逻辑循环，原循环标记子树保存在 `ast`。
- `exchangeQuoteNode`：移除单双引号定界节点，为其中节点添加 `quote` 元数据。
- `createAddUid`：创建文档级计数会话，为节点分配稳定 `uid`；在结构转换后调用，每份文档使用新实例。
- `addDocumentUid`：为已转换文档一次性分配稳定 ID，自动创建新会话。
- `collectName`：收集命名枚举、循环作用域及其变量路径。
- `copyNode`：深复制节点树。

`reduceBlocks` 可以实现依赖注释约定的状态式上层逻辑，而不会把这些约定耦合到 parser：

```ts
const definitions = reduceBlocks(
  document.blocks,
  (result, block) => {
    // 调用方自行解释 block.comment，并决定如何组合 block.ast。
    result.push({ comment: block.comment, ast: block.ast });
    return result;
  },
  [] as Array<{ comment: string; ast: Node }>,
);
```

公共遍历工具包括：

- `walk`：转换或过滤一个 AST 的后代节点。
- `walkBlocks`：对每个 Block 的 AST 应用一组 Node Walker。
- `walkDocument`：对文档中所有 AST 应用一组 Node Walker。
- `exchangeBlocks`：转换 Block，同时保留原有顺序。
- `reduceBlocks`：基于 Block 顺序构建调用方自己的逻辑模型。
- `cleanBlank`：移除 `BLANK` 节点。
- `copyNode`：复制完整节点树。

## 稳定节点 ID

原始解析不自动添加 UID。推荐先统一结构转换，再为文档分配：

```ts
import {
  SNFDocumentParser, walkDocument, exchangeQuoteNode, exchangeLoopNode,
  addDocumentUid,
} from 'snf-parser';

const raw = new SNFDocumentParser().parse(source);
const logical = walkDocument(raw, exchangeQuoteNode, exchangeLoopNode);
const identified = addDocumentUid(logical);
```

格式为 `{类型码4位}-{深度4位}-{路径哈希32位}-{同前缀序号4位}`，例如类型码 `VA00` 表示 VARIABLE。深度从 `0000` 开始，同前缀序号从 `0000` 开始，两者上限 `FFFF`；越界明确报错。静态类型登记见 `UID_TYPE_CODES`，规则版本为 `UID_VERSION = 'snf-uid-v1'`。

VARIABLE、ENUM、LOOP 使用当前作用域最近一段连续 DEFINITION（如 `ORDER BY`）作为标识。子结构继承上下文，退出后恢复；枚举各候选独立，每个 Block 重置。OPTIONAL 只取直接子节点中第一个 DEFINITION、NUMBER、OTHER；ROOT/GROUP 不寻找标识。路径逐级包含祖先类型与标识，不含变量名、源码偏移、注释、推导名称或祖先序号。哈希固定为 UTF-8 SHA-256 前 128 位，碰撞检测后报错。

因此 `SELECT a` 改成 `SELECT b`、普通排版调整、带不同关键字段的完整功能片段换序可保持对应 ID；同前缀重复位置仍用序号区分，新增同前缀节点可能使后续序号顺延。真实包裹、关键字段或 Walker 配置变化允许改变 ID。只保证单文档内唯一，跨文件引用仍需带文档标识。

`children` 和 `ast` 均分配 ID，并以不同路径边隔离；引号类型和引号内有意义的空白参与身份。输入树不变，已有 UID 会被重新计算。`createAddUid()` 可接入 Walker 流程，但不能将同一实例跨文档复用。

完整类型表、编码协议、栈规则和稳定性边界见 [稳定 ID 设计](docs/snf-ast-stable-id-design.md)。

## 错误

非法闭合、未闭合 Block、尾随转义符和非法重复标记会抛出 `SNFParseError`。错误对象提供：

- `offset`：相对当前 Block 内容的零起点偏移。
- `line`、`column`：当前 Block 内的一起点位置。
- `expected`：如果适用，记录期望的字符或结构。

## 开发

```bash
pnpm install
pnpm test
pnpm test:uid
pnpm test:complex
pnpm build
```

`pnpm build` 先清理 `dist`，再生成 JavaScript 和类型声明，确保输出只包含当前接口。

`pnpm test` 覆盖显式可选与枚举结构、非法分隔符的位置、紧凑重复写法、转义错误、Walker 不可变性和文档 Block 边界，以及稳定 UID 的作用域、换序、改名、碰撞、溢出和不可变性回归；`pnpm test:uid` 可单独运行后者。

`pnpm test:complex` 会读取同级的 `mysql`、`postgres`、`oracle`、`sqlserver` 仓库，先验证一组复杂真实文档的结构覆盖，再扫描四库中的全部 `.snf` 文件，检查显式 ENUM、GROUP 归属和源码范围，并验证转换后 UID 的唯一性、重新解析确定性和变量批量改名稳定性。可通过 `SNF_MYSQL_ROOT`、`SNF_POSTGRESQL_ROOT`、`SNF_ORACLE_ROOT`、`SNF_SQLSERVER_ROOT` 指定其他路径。此命令会校验数据库定义，应遵守各仓库的显式授权要求；不作为普通单元测试自动执行。
