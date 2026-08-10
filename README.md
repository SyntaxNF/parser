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

为了兼容旧版本，`SNFFileParser.parse(source)` 仍异步返回 `Block[]`。新代码推荐使用同步的 `SNFDocumentParser.parse(source)`，这样可以同时保留完整文档源码。

## SNF 基础记号

| 记号 | AST 节点 | 含义 |
| --- | --- | --- |
| `KEYWORD` | `DEFINITION` | 大写字母开头，由大写字母、数字和下划线组成。 |
| `placeholder` | `VARIABLE` | 小写字母开头，由小写字母、数字和下划线组成。 |
| `123` | `NUMBER` | 以数字开头的数字字面量。 |
| `[ syntax ]` | `OPTIONAL` | 整个内容可选。 |
| `{ a \| b }` | `ENUM` | 从候选 Group 中选择一个。 |
| `syntax [...]` | `LOOP`、`REPEAT` | 前面的语法可以重复；重复标记必须恰好是 `...`。 |
| `\|` | `SPLIT` | 枚举候选分隔符。 |
| 空格、Tab | `BLANK` | 水平空白。 |
| 换行 | `WRAP` | 内容块内部的换行。 |
| `'`、`"` | `QUOTE`、`DOUBLEQUOTE` | 原样保留的引号字符。 |
| 其他符号 | `OTHER` | 圆括号、逗号、点号和运算符等符号。 |

反斜杠用于转义下一个字符。叶子节点的 `content` 保存解码后的内容，`raw` 保留原始输入：

```ts
new SNFParser().parse(String.raw`value\|part`);
```

可选块和枚举块末尾支持 `as name` 元数据。名称写入节点的 `name` 字段，不再作为候选子节点输出：

```snf
{ colname coltype as column_definition }
```

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

Walker 不修改输入 AST，而是返回新树。`exchange` 默认在访问子节点前执行，`filter` 在转换完成后执行；根节点本身不会被删除。

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
- `createAddUid`：创建有独立计数状态的 Walker，为节点添加四位字母 `uid`。
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

## 错误

非法闭合、未闭合 Block、尾随转义符和非法重复标记会抛出 `SNFParseError`。错误对象提供：

- `offset`：相对当前 Block 内容的零起点偏移。
- `line`、`column`：当前 Block 内的一起点位置。
- `expected`：如果适用，记录期望的字符或结构。

## 开发

```bash
pnpm install
pnpm test
pnpm test:complex
pnpm build
```

`pnpm test` 覆盖基础节点、紧凑重复写法、转义错误、Walker 不可变性和文档 Block 边界。

`pnpm test:complex` 会读取同级的 MySQL 和 PostgreSQL SNF 仓库，先验证一组复杂真实文档的结构覆盖，再扫描两个仓库中的全部 `.snf` 文件。可通过 `SNF_MYSQL_ROOT` 和 `SNF_POSTGRESQL_ROOT` 指定其他路径。
