# SNF 最终 AST 与稳定节点标识

## 目标与边界

一次 parse 返回当前模板的完整语法结构，本地定义替换与循环绑定由 parser 完成，UID/name 在结构确定后统一生成。不读取之前的解析结果，不依赖文件缓存或人工名称映射。

输入值、枚举选择、可选项开关与循环次数由消费方提供。递归语法用已解析的引用表示有限图；STATEMENT 只保留声明与类别，既不解析类别文本，也不跨文件加载模板。

## 编译顺序

1. 保留物理行和源码块，收集 CASE、WHERE、ONEOFIS、PARTOFIS、STATEMENT。
2. 构建本地名称表，检查重名、命名规则与块归属，支持前向引用及别名。
3. 解析内容，显式构建 OPTIONAL/ENUM/GROUP，组合 QUOTED 并绑定完整 LOOP 成员。
4. ONEOFIS 按行、PARTOFIS 按块构建候选。
5. 根据本地定义依赖图识别强连通分量。递归定义使用 REFERENCE，其余本地引用用 COLLECTION 包裹并展开。
6. 按入口顺序、定义声明顺序，使用一个文档会话分配最终节点的 uid/name。
7. 将 REFERENCE.target 绑定到已生成的定义根 UID。

`document.entries` 为顶层入口，`document.definitions` 为已编译的定义集合。`document.blocks` 仅保留源码信息。所有结构子节点只存在于 children，LOOP 分隔符存于 separator，QUOTED 定界符存于 quote。

非合成节点通过 sourceBlock 和 start/end 指回来源；被展开的子节点可能来自不同源码块。ONEOFIS/PARTOFIS 的合成 ROOT/ENUM 标记 synthetic=true。

## SNF 显式结构

- `[]` 表示可选序列，`{}` 表示枚举；`[ A | B ]` 非法，可选枚举为 `[ { A | B } ]`。
- GROUP 只表示 ENUM 中非空的一个候选；重复枚举时 LOOP 包含整个 ENUM，不直接提升 GROUP。
- `item [, ...]` 编译为 LOOP(children=[item], separator=',')；前项不是额外必选首项。
- WHERE helper 展开为 COLLECTION(children=定义内容)。包裹保留 binding={name,kind}，其名称不参与 UID。
- 递归引用 REFERENCE 保存 binding、name 和已解析 target。目标内容在 definitions 中，不做无限展开。
- STATEMENT 保存名称和类别标签。类别不作为 SNF 内容解析；类别顺序与拼写按原文保留。
- QUOTED 保留完整引号序列（包括空序列），内部空白有意义。

## UID 四段格式

```
TTrr-DDDD-HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH-NNNN
```

| 字段 | 定义 |
| --- | --- |
| TTrr | 前两位类型缩写，后两位缩写冲突登记号，固定 4 位 |
| DDDD | 最终 AST 深度，根为 0000，十六进制大写，上限 FFFF |
| H…H | 功能路径的 128 位哈希，以 32 位大写十六进制表示 |
| NNNN | 全文档相同前三段前缀下的出现序号，0000–FFFF |

版本 `UID_VERSION='UID_V1'`。代码登记只追加，不随遍历动态分配、不回收复用。

| 类型 | 类型码 | 含义 |
| --- | --- | --- |
| ROOT | RO00 | 入口或定义根 |
| COLLECTION | CO00 | 本地定义展开包裹 |
| LOOP | LO00 | 完整成员重复 |
| OPTIONAL | OP00 | 整段可选 |
| ENUM | EN00 | 枚举 |
| GROUP | GR00 | 枚举候选 |
| DEFINITION | DE00 | 固定关键字 |
| VARIABLE | VA00 | 输入槽位 |
| NUMBER | NU00 | 数值文本 |
| OTHER | OT00 | 固定符号 |
| BLANK | BL00 | 水平空白 |
| WRAP | WR00 | 换行 |
| QUOTED | QT00 | 完整引号序列 |
| REFERENCE | RF00 | 已绑定递归引用 |
| STATEMENT | ST00 | 嵌套语句声明标识 |
| SPLIT | SP00 | 内部语法阶段候选分隔符，最终树不含此节点 |
| REPEAT | RE00 | 内部语法阶段重复标记，最终树不含此节点 |
| QUOTE | QU00 | 内部单引号定界符，最终树不含此节点 |
| DOUBLEQUOTE | DQ00 | 内部双引号定界符，最终树不含此节点 |

## DEFINITION 作用域栈

每个 children 序列持有独立 frame：`keywords`（最近的连续关键字串）、`collecting`（是否仍可连接下一关键字）、`quote`（引号上下文）。

- DEFINITION 在引号外更新 frame：连续时追加，否则开启新的串。
- BLANK/WRAP 在引号外不打断连续串，`ORDER\nBY` 与 `ORDER BY` 等价。
- 变量、符号、结构等会结束连续收集，但保留最近的 keywords 供后续动态节点使用。
- 子结构继承进入时的 keywords，collecting 重置；内部串不会连接到父串上，也不写回父 frame。
- GROUP 分支分别继承，互不污染。每个入口、每个定义根单独建立空 frame。
- QUOTED 内 DEFINITION 不更新关键字上下文，引号内变动不影响外部上下文。
- 当前节点先读取进入时的 frame，之后才更新其后续兄弟节点的 frame。

例如 `OUTER [ INNER value ] tail`：value 使用 INNER，tail 使用 OUTER；`ORDER BY column` 的变量使用 `[ORDER,BY]`。

## 功能路径的局部标识

| 类型 | local |
| --- | --- |
| DEFINITION / NUMBER / OTHER | `[类型码, content]` |
| COLLECTION / VARIABLE / ENUM / LOOP / REFERENCE / STATEMENT | 有关键字时 `['DEFINITION_CONTEXT', keywords]`，否则 null |
| OPTIONAL | 第一个直接 DEFINITION / NUMBER / OTHER 的 `[类型码,content]`；否则 null |
| ROOT / GROUP / QUOTED | null，不寻找名称 |
| 引号内 BLANK / WRAP | `[类型码,content]` |
| 引号外 BLANK / WRAP | null |

COLLECTION 与其被替换的变量一样，使用调用位置的功能标识；定义体的新关键字不会抹去调用位置的祖先哈希。例如 `SELECT item FROM item` 中，即使 item 的定义都是 `VALUE x`，两个调用及其内部节点在整段换序后仍各自保持 ID。

OPTIONAL 不进入嵌套结构查找标识。`[ ORDER BY column ]` 取 ORDER；`[ { A | B } ]` 不借用 A。

## 哈希协议

每个节点编码为 JSON 数组，保证字段边界：

```ts
[
  'UID_V1',
  parentHash,             // 根为 null
  edge,                   // 根为 'root'，子节点为 'children'
  typeCode,
  local,
  effectiveQuote ?? null, // 当前或继承的引号类型
  type === LOOP ? separator : null,
  type === STATEMENT ? categories : null,
]
```

对该 JSON 字符串做 UTF-8 SHA-256，截取前 16 字节，编码为大写十六进制。parentHash 逐级包含所有祖先的类型和功能标识，**不包含祖先的同前缀序号**。节点自身的深度单独放在 UID 第二段。

变量、helper、CASE 名称、binding、target、源码坐标、注释和 name 不进入哈希。target 在 UID 分配后绑定，不形成哈希循环。固定关键字、真实包裹、引号、循环分隔符、STATEMENT 类别则属于结构或语义信息。

文档会话缓存路径与哈希，检测不同路径得到相同摘要时立即报错。深度或序号超过 FFFF 明确报错，不截断或回绕；内部失败分配不消耗会话计数。

## 同一次遍历生成 name

- VARIABLE、REFERENCE、STATEMENT：取自身 content，保留大小写。
- OPTIONAL：直接第一个固定描述转大写，默认 OPTIONAL。
- ENUM、LOOP：当前 keywords 转大写，以 `_` 连接；默认 ENUM 或 LOOP。
- 其他节点不自动命名。名称允许重复，不能替代 UID。

## 完整例子

```snf
# CASE SELECT_LIST
SELECT projection [, ...] [ LIMIT count ] [ OFFSET position ]

# WHERE projection
column [ AS col_alias ]
```

最终主树（省略空白和固定文本节点）：

```
ROOT
├─ LOOP name=SELECT separator=","                       depth=1
│  └─ COLLECTION binding=projection                     depth=2
│     ├─ VARIABLE name=column                           depth=3
│     └─ OPTIONAL name=AS                               depth=3
│        └─ VARIABLE name=col_alias                     depth=4
├─ OPTIONAL name=LIMIT                                 depth=1
│  └─ VARIABLE name=count                              depth=2
└─ OPTIONAL name=OFFSET                                depth=1
   └─ VARIABLE name=position                           depth=2
```

将 projection 及其声明统一改名、column 改成 other_column，LOOP 及内部变量 UID 不变；变量 name 随输入拼写变化。交换 LIMIT 与 OFFSET 两个完整可选段，它们及其内部变量的 UID 不变。

`SELECT a, b` 改成 `SELECT b, a` 时，第一个位置仍是同前缀序号 0000，第二个仍是 0001；ID 对应功能位置，不追随变量拼写移动。

## 稳定性边界与验证

不同功能前缀之间的插入与重排互不影响；相同前缀的多个位置必须通过序号区分，在它们中间插入同前缀节点仍可能改变后续 ID。不承诺定义内联和抽取、真实括号包裹变化、递归环变化或不同入口结构得到相同 ID。

声明顺序不影响入口已经展开的功能路径；定义集合自身的相同前缀序号可能因声明重排变化。ID 唯一性限定在一份文档内；跨文件需携带文档标识。

单元回归覆盖结构展开、前向引用和别名、递归图、STATEMENT 不展开、完整循环、引号、sourceBlock 定位、功能换序、变量/helper 改名、作用域隔离、SHA 向量、碰撞和 FFFF 溢出。四库全量验证覆盖最终 AST 来源范围、元数据唯一性和独立解析确定性，生成回归验证 0/1/2 次循环与输入保留。
