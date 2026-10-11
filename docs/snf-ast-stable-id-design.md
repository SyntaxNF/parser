# SNF 语法与稳定节点 ID

本文定义 SNF 显式语法与稳定节点 ID v1 的规则。

节点 `uid` 根据 SNF 的显式语法结构生成，目标是在每次独立解析时，让变量改名、排版调整、可区分功能块换序尽量不改变节点 ID，并将不可避免的顺序影响限制在同一前缀的节点中。

ID 表示语法中的功能位置，不追踪变量名称对应的实体。生成过程只使用当前文档和固定的解析配置。功能节点和变量节点是稳定性的重点。

## 基本规则

| 项目 | 规则 |
| --- | --- |
| 生成输入 | 只根据当前 SNF 和固定的解析配置生成 ID |
| 变量改名 | 变量名称不参与身份判断 |
| 显式结构 | `[]` 表示可选，`{}` 表示枚举 |
| ID 字段宽度 | 类型码、深度、同前缀序号分别为四位 |
| OPTIONAL 标识 | 取直接子节点中第一个 DEFINITION、NUMBER、OTHER 的固定内容 |
| ROOT 和 GROUP 标识 | 不主动寻找局部标识 |
| 固定描述节点标识 | DEFINITION、NUMBER、OTHER 使用自身内容 |
| VARIABLE、ENUM 和 LOOP 标识 | 使用 DEFINITION 上下文栈中最近一段连续关键字 |
| 上下文作用域 | 进入子结构时继承，退出时恢复；枚举候选相互隔离，每个 Block 重置 |
| 哈希及遍历 | SHA-256 前 128 位、版本化 JSON、父摘要链、先 children 后 ast |

## SNF 语法

### 可选与枚举分别表达

| 写法 | 合法性 | 结构 |
| --- | --- | --- |
| `[ A B ]` | 合法 | OPTIONAL 直接包含 A、B |
| `{ A \| B }` | 合法 | ENUM 包含两个 GROUP |
| `[ { A \| B } ]` | 合法 | OPTIONAL 包含显式 ENUM |
| `{ A }` | 合法 | 显式 ENUM 包含一个 GROUP |
| `[ A \| B ]` | 非法 | OPTIONAL 内不能直接使用候选分隔符 |
| `A \| B` | 非法 | 候选分隔符必须直接属于显式 ENUM |
| `{ [ A \| B ] }` | 非法 | 外层枚举不能让内层 OPTIONAL 接受候选分隔符 |

未转义的 `|` 仅能在 `{}` 对应的当前层级划分候选。转义的 `\|` 仍属于普通内容。GROUP 表示一个候选内部的序列，不需要额外的源码定界符。

例如：

```snf
[ LIMIT count ]
```

AST 为：

```text
ROOT
└─ OPTIONAL
   ├─ DEFINITION: LIMIT
   └─ VARIABLE: count
```

需要同时表达可选和选择时，必须显式写出两种结构：

```snf
[ { ASC | DESC } ]
```

```text
ROOT
└─ OPTIONAL
   └─ ENUM
      ├─ GROUP
      │  └─ DEFINITION: ASC
      └─ GROUP
         └─ DEFINITION: DESC
```

节点的 `raw/start/end` 保存准确的源码范围。重复标记 `[...]`、`[, ...]` 由 parser 识别，通过 Loop Walker 绑定完整的前项。

### 名称元数据

`Node.name` 由调用方附加，或通过名称 Walker 推导。注释名称、`Node.name` 以及 Walker 自动推导的名称均不参与 ID。

GROUP 的直接父节点是 ENUM。Loop Walker 可以把 ENUM 整体放到 LOOP 下，但不会将 GROUP 直接提升为 LOOP 的子节点。

## ID 格式与类型登记

```text
{类型码4位}-{深度4位}-{功能路径哈希}-{同前缀序号4位}
```

四部分分别回答：当前是什么类型、位于第几层、属于哪条功能路径、是该前缀下的第几个位置。字段名为 `uid`，由 `createAddUid()` 分配。原始 parser 不自动分配 UID。

### 类型码

前两位是大写类型缩写，后两位是在同一缩写下登记的类型编号。后两位使用十六进制 `00–FF`。

类型表必须静态登记，不得按解析过程中遇到类型的先后动态注册。新增同缩写类型使用下一个未分配编号，已分配编号不重排，停用编号不复用。

以下是固定登记表；`NodeType` 枚举值与 ID 类型码分别定义。

| NodeType | 当前枚举值 | 类型码 | 含义 |
| --- | --- | --- | --- |
| ROOT | root | RO00 | 根节点 |
| COLLECTION | ct | CO00 | 集合节点 |
| LOOP | lo | LO00 | 循环节点 |
| OPTIONAL | op | OP00 | 可选节点 |
| ENUM | em | EN00 | 枚举节点 |
| GROUP | g | GR00 | 枚举候选序列 |
| SPLIT | s | SP00 | 候选分隔符 |
| REPEAT | r | RE00 | 重复标记 |
| DEFINITION | d | DE00 | 固定关键字 |
| VARIABLE | v | VA00 | 变量位置 |
| NUMBER | n | NU00 | 数字字面量 |
| BLANK | b | BL00 | 水平空白 |
| WRAP | w | WR00 | 换行 |
| QUOTE | q | QU00 | 单引号 |
| DOUBLEQUOTE | dq | DQ00 | 双引号 |
| OTHER | o | OT00 | 其他符号 |

例如未来另一个类型同样使用 `CO` 缩写，则登记为 `CO01`，现有 COLLECTION 始终使用 `CO00`。

### 深度

使用四位大写十六进制 `0000–FFFF`，根节点为 `0000`，每经过一条 AST 父子边加一。达到 65,536 层时超出取值范围，明确报错，不回绕。

深度基于固定阶段的 AST。先确定显式语法和 Loop、Quote 等转换配置，再分配 ID；不能承诺不同转换配置产生相同 ID。

在原始 AST 中，`[ LIMIT count ]` 的 OPTIONAL 深度为 `0001`，变量深度为 `0002`。增加真实语法包裹会改变深度，允许相关 ID 改变。

### 同前缀序号

对“类型码、深度、功能路径哈希”完全相同的节点单独计数，使用 `0000–FFFF`。同一前缀最多容纳 65,536 个节点，继续增加时明确报错。

计数范围为一次完整文档解析，按固定遍历顺序计数，解析下一份文档时重新开始。若每个 Block 都重新计数，就不能保证文档内 UID 唯一。

序号只区分同前缀的位置，不参与子节点的功能路径。根节点或 GROUP 的序号改变，不应仅因此传递给所有后代。

## 功能路径标识的获取

### 基本规则

先得到可读的路径标识，再计算哈希。每个节点在父级路径后追加自己的类型和局部标识：

```text
path(node) = path(parent) + segment(node)
segment(node) = [类型码, 局部标识或空值]
```

根节点只包含自己的结构片段。ROOT 不提取语句起始关键字。GROUP 同样不寻找局部标识，但其类型和深度仍然存在。它们自身没有标识，不妨碍遍历其内部序列时维护 DEFINITION 上下文。

路径不包含变量名称、注释、推导名称、兄弟下标、Block 下标、父节点 UID、父节点完整内容、普通排版空白或源码偏移。路径中也不包含任何祖先的同前缀序号。

相同类型和相同路径可以出现多次，由最终序号区分。路径哈希本身不承担每个节点都唯一的职责。

### OPTIONAL 的局部标识

OPTIONAL 使用第一个类型属于 DEFINITION、NUMBER、OTHER 的固定描述节点。只按顺序扫描 OPTIONAL 的直接 children，跳过其他类型，不进入嵌套结构。

局部标识同时保留该描述节点的类型及其解码后的 `content`，不使用 `raw`。例如：

| OPTIONAL 内容 | 局部标识 |
| --- | --- |
| `[ LIMIT count ]` | DEFINITION 与 LIMIT |
| `[ ORDER BY column ]` | DEFINITION 与 ORDER，不拼接整个 ORDER BY |
| `[ value = other ]` | OTHER 与等号 |
| `[ 10 value ]` | NUMBER 与 10 |
| `[ value ]` | 空 |
| `[ { A \| B } ]` | 空，不从 ENUM 候选中寻找 |

这不是完整的功能语义识别。不同结构如果都以 ORDER 开头，仍可能得到相同标识。插入一个更靠前的固定描述节点，也可能改变该 OPTIONAL 及其后代的路径，这是该提取规则的明确边界。

### DEFINITION 上下文栈

VARIABLE、ENUM、LOOP 统一从 DEFINITION 上下文栈获取局部标识。栈中保存最近一段连续 DEFINITION 的解码内容，例如 `["ORDER", "BY"]`，不保存这些节点的 UID、位置或变量名称，也不只取最后一个关键字 BY。

每个栈帧对应一个 AST 序列作用域，保存当前关键字段以及是否仍在收集连续关键字的状态。深度用于描述层级，实际压栈和弹栈必须根据 AST 的进入、离开事件处理，不能只比较深度数值。同深度的兄弟 GROUP 仍是不同作用域。

规则如下：

1. 开始一个 Block 时建立空上下文，不继承前一个 Block 的末尾关键字。
2. 进入子结构时压栈，复制父层当前关键字段，并将连续收集状态设为关闭。继承的字段可被使用，但不能与子层第一个关键字直接拼接。
3. 遇到 DEFINITION 时，若正在收集连续关键字，则追加其内容；否则用该节点开始新的关键字段，替换当前字段。
4. 普通 BLANK、WRAP 不结束连续收集，也不改变当前字段。因此 ORDER BY 跨普通换行仍是同一个字段；空行划分 Block 的行为另行生效。
5. 遇到变量、数字、符号或子结构时，结束连续收集，但保留当前字段。NUMBER、OTHER 不更新 DEFINITION 上下文，这与它们可作为 OPTIONAL 自身标识是两套规则。
6. VARIABLE 读取所在层当前字段作为局部标识。ENUM、LOOP 在进入自身子结构之前读取外层字段，固定自己的局部标识。
7. 离开子结构时弹栈，恢复外层字段。内部关键字不回写外层；经过子结构后，外层连续收集状态仍为关闭。
8. ENUM 中各 GROUP 分别继承相同的枚举层上下文。前一个候选的最后一个关键字不能传给后一个候选。

枚举或循环内部出现新的关键字，只改变该内部作用域后续节点使用的字段，不重新计算已经确定的 ENUM、LOOP 局部标识。读取标识时应保留字段值的快照，不能因后续追加关键字而改变前面节点的标识。

例如：

```snf
ORDER BY column
PARTITION BY partition_column
```

两个变量分别使用 `["ORDER", "BY"]` 和 `["PARTITION", "BY"]`，不会因为都以 BY 结尾而落入同一个标识。

### 变量枚举与循环的统一标识

下列三个节点虽然接受的内容形式不同，但都使用所在功能的固定关键字段：

```snf
MODE mode
FORMAT { JSON | XML }
COLUMNS column [, ...]
```

| 节点 | 局部标识 | 功能路径示意 |
| --- | --- | --- |
| 变量 mode | MODE | ROOT → VARIABLE:MODE |
| 枚举 | FORMAT | ROOT → ENUM:FORMAT |
| 循环 | COLUMNS | ROOT → LOOP:COLUMNS |
| 循环内变量 column | COLUMNS | ROOT → LOOP:COLUMNS → VARIABLE:COLUMNS |

该例按 Loop Walker 完成转换后的树计算。ID 上下文遍历必须在固定的结构转换阶段之后执行，避免循环归属和深度在分配 ID 后才变化。

将上述三个完整功能片段交换顺序，关键字段仍分别是 MODE、FORMAT、COLUMNS；变量改名也不会改变它们。带有 OPTIONAL 父级时，继续保留该父级路径，同时使用当前 DEFINITION 字段作为自身标识。

例如：

```snf
MODE { A | B }
FORMAT { C | D }
```

两个 ENUM 的路径现在分别为 `ROOT → ENUM:MODE` 和 `ROOT → ENUM:FORMAT`，不再只能靠顺序区分。

### 子结构隔离与 GROUP

例如：

```snf
USING { BTREE | HASH } index
```

上下文变化为：

```text
外层当前字段为 USING
├─ ENUM 读取 USING，进入时继承 USING
│  ├─ GROUP 1 继承 USING，内部更新为 BTREE，退出后丢弃
│  └─ GROUP 2 继承 USING，内部更新为 HASH，退出后丢弃
└─ 返回外层，当前字段仍为 USING
   └─ index 读取 USING
```

交换 BTREE、HASH 候选后，外部 index 的标识仍是 USING。GROUP 自身不寻找局部标识，只负责候选容器和独立的上下文作用域。

在 `{ LIMIT a | OFFSET b }` 中，两个变量的路径分别是：

```text
ROOT → ENUM:空 → GROUP → VARIABLE:LIMIT
ROOT → ENUM:空 → GROUP → VARIABLE:OFFSET
```

交换候选后，变量可以继续对应 LIMIT、OFFSET。GROUP 自身仍共享同一前缀，由序号表示第一、第二个候选位置；其序号不进入子节点路径。

### 无上下文与相同上下文

没有可继承或已读取的 DEFINITION 字段时，VARIABLE、ENUM、LOOP 的局部标识为空，不使用变量名或第一个枚举候选兜底。

在 `SELECT a, b` 中，两个变量都使用 SELECT 标识，分别对应第一、第二个变量位置。逗号结束连续关键字收集，但不清除 SELECT 上下文。

同一父级路径下，两处得到相同字段时仍依赖同前缀序号。例如重复出现两个 MODE 枚举，或者出现多个没有关键字的变量与枚举，不能保证它们交换后仍跟随原功能。

上下文栈解决的是不同固定关键字段之间的区分，不是完整的 SQL 语义分析。移动节点离开原关键字段、修改字段内容、在变量之前插入新的 DEFINITION，均可能改变该节点及其后代的身份。功能换序稳定要求移动的是携带自身关键字段的完整片段，且功能路径仍可区分。

### 固定描述与辅助节点

DEFINITION、NUMBER、OTHER 使用自身类型及解码内容。它们的变化影响自身身份，但不会自动作为父节点的整体内容重新计算所有后代路径。被 OPTIONAL 选作局部标识，或者 DEFINITION 被后续节点作为上下文字段使用时，变化会沿相应依赖传播。

BLANK、WRAP 的长度和数量不参与其他节点的路径或计数分组。它们自己的 ID 不要求在排版修改后保持不变。

辅助节点规则固定如下：

| 节点/元数据 | 局部标识 |
| --- | --- |
| ROOT、GROUP、COLLECTION | `null`，不搜索后代 |
| SPLIT、REPEAT、QUOTE、DOUBLEQUOTE | `[类型码, 解码 content]` |
| 普通 BLANK、WRAP | `null`，长度不进入哈希 |
| 引号内 BLANK、WRAP | `[类型码, content]`，保留有意义的空白 |
| 所有节点的引号 | 单独保留有效 `quote` 字段，无引号为 `null` |

未使用 Quote Walker 时，按当前序列中的 QUOTE/DOUBLEQUOTE 定界符维护引号状态；使用该 Walker 时读取节点 `quote` 元数据。子结构继承引号状态，但内部改变不泄漏到外层。引号内 DEFINITION 仍以自身内容生成 ID，但不更新外层关键字段，也不能与外层关键字组成连续字段。引号内 VARIABLE 仍表示可改名的输入槽位，而非固定 SQL 字面值。不同 Walker 配置之间不承诺相同 UID。

Loop Walker 保留的 `ast` 辅助子树也分配 UID。`children`、`ast` 的边标记参与路径；它们分别复制进入节点时的上下文，互不污染。`ast` 是单节点时保留单节点形状，是数组时保留数组。两种属性中的节点深度都为父深度加一，不增设虚拟容器。

### 固定哈希编码 v1

为避免深树反复拼接完整路径，采用父摘要链，每段的实际输入严格为：

```ts
JSON.stringify([
  'snf-uid-v1',
  parentHash, // 根为 null，其他为父节点的 32 位大写摘要
  edge,       // 根为 'root'，子树为 'children' 或 'ast'
  typeCode,
  local,      // 见下表
  quote,      // null、单引号或双引号
])
```

| 情况 | local |
| --- | --- |
| 无标识 | `null` |
| 固定描述节点或 OPTIONAL 找到首个固定描述 | `[描述类型码, 解码 content]` |
| VARIABLE/ENUM/LOOP 找到关键字段 | `["DEFINITION_CONTEXT", ["ORDER", "BY"]]` 等 |
| 上表中的辅助内容 | `[当前类型码, content]` |

父摘要逐级包含所有祖先的结构与标识，但不包含祖先序号。序列化使用 JSON 原生字符串转义与数组边界，不拼接关键字。字符串不做 Unicode 或大小写归一化；以 UTF-8 编码，计算 SHA-256，取前 16 字节（128 位），输出 32 个大写十六进制字符。实现不依赖 Node API、随机数或平台散列，浏览器和 Node 使用相同算法。

输出格式为 `类型码-深度-哈希-序号`，总长 47 个字符。算法版本写入每段哈希输入；后续改变规则必须升级版本，不静默改变 v1 语义。

分配器同时登记摘要与对应段的完整序列化输入。不同输入得到同一摘要时立即报错，包含父摘要的段也逐级检查，因此不会默默把不同路径合成同组。相同路径则正常共享前缀计数。

遍历顺序为前序：当前节点、`children` 数组、`ast` 子树。非递归任务栈持有独立序列栈帧，进入子树时继承、退出后恢复；同层兄弟共用该层帧，各 GROUP 子序列使用独立帧。深度和序号越过 FFFF 时抛出 `RangeError`，不回绕，也不先触发 JavaScript 递归栈溢出。失败的 Block 会回滚本次新增路径和计数；输入 AST 始终不变，输入已有 UID 会重新计算。

### 分配入口

```ts
import {
  SNFDocumentParser, walkDocument, exchangeQuoteNode, exchangeLoopNode,
  addDocumentUid, createAddUid,
} from 'snf-parser';

const raw = new SNFDocumentParser().parse(source);
const logical = walkDocument(raw, exchangeQuoteNode, exchangeLoopNode);
const result = addDocumentUid(logical);
```

`addDocumentUid` 每次创建独立分配会话；计数覆盖该文档全部 Block，DEFINITION 上下文在每个 Block 重置。它只分配 ID，不隐式执行 Quote/Loop 等转换。

`walkBlocks` 或 `walkDocument` 调用链可传 `createAddUid()`，但每份文档必须创建一个新实例；同文档所有 Block 共用一个实例。分配 ID 必须放在固定的结构转换阶段之后，后续若再次改变结构，应重新分配。

## 完整示例与稳定边界

以下基于显式 AST，以及 VARIABLE、ENUM、LOOP 使用连续 DEFINITION 上下文的规则。

修改前：

```snf
SELECT a, b
[ LIMIT count ]
[ OFFSET position ]
```

修改后：

```snf
SELECT b, a
[ OFFSET offset_value ]
[ LIMIT limit_value ]
```

表中的 HS、HL 等是哈希结果的代称，不是真实输出；实际第三部分使用固定长度摘要。

| 功能位置 | 修改前 | 修改后 | 保持不变的 ID 示意 |
| --- | --- | --- | --- |
| 根下第一变量 | a | b | VA00-0001-HS-0000 |
| 根下第二变量 | b | a | VA00-0001-HS-0001 |
| LIMIT 可选结构 | LIMIT count | LIMIT limit_value | OP00-0001-HL-0000 |
| LIMIT 参数 | count | limit_value | VA00-0002-HLV-0000 |
| OFFSET 可选结构 | OFFSET position | OFFSET offset_value | OP00-0001-HO-0000 |
| OFFSET 参数 | position | offset_value | VA00-0002-HOV-0000 |

根下两个变量共享路径 `ROOT → VARIABLE:SELECT`，按位置分配序号。LIMIT、OFFSET 的变量分别具有 `ROOT → OPTIONAL:LIMIT → VARIABLE:LIMIT` 和 `ROOT → OPTIONAL:OFFSET → VARIABLE:OFFSET` 路径，调整两个功能块的顺序不会改变路径。

如果将 `SELECT a, b` 改成 `SELECT x, a, b`，前两个位置继续使用序号 `0000`、`0001`，第三个位置使用 `0002`。变量按位置对应，不追踪名称 a、b。

| 修改 | 预期边界 |
| --- | --- |
| 变量改名 | 保持 ID |
| 普通排版变化，Block 边界不变 | 保持功能节点和变量节点 ID |
| 不同 OPTIONAL 标识的功能块换序 | 保持各功能路径及节点 ID |
| 携带不同 DEFINITION 字段的完整片段换序 | 父级路径与字段保持一致时，变量、枚举、循环的 ID 保持不变 |
| 不同关键字段的枚举候选换序 | 内部变量可跟随功能；GROUP 自身仍按候选位置编号 |
| 枚举内部候选换序 | 不改变外部后续节点的上下文 |
| 新增不同前缀的节点 | 不占用已有前缀序号 |
| 增加或删除同前缀节点 | 该组后续序号可能顺延 |
| 相同标识的功能块或匿名候选换序 | 按位置对应，不保证跟随原功能 |
| 增加可选或枚举包裹 | 路径、深度变化，允许 ID 改变 |
| 改变 OPTIONAL 选中的固定描述 | 该节点及后代路径变化，允许 ID 改变 |
| 修改关键字段或将节点移动到其他字段下 | 使用该上下文的节点及其后代允许改变 ID |
| 改变 Block 边界或 AST 转换配置 | 不保证原 ID 稳定 |

ID 只保证单个文档内唯一。跨文件引用使用文档标识与节点 ID 的组合，不承诺不同文件独立生成的裸 UID 全局唯一。跨 Block 相同路径仍会共享计数组，因此稳定性不能描述为所有 Block 完全互不影响。

## 实现与验收

- `pnpm test` 包含原 parser 回归和 `test/uid.ts`；也可用 `pnpm test:uid` 单独执行稳定 ID 回归。
- 稳定性回归覆盖独立解析、变量改名、不同前缀插入、功能片段与候选换序、同前缀位置编号、真实包裹变化、连续关键字段、作用域继承恢复、GROUP 隔离、Block 重置、辅助子树、引号与解码内容、输入不可变性、FFFF 边界及碰撞失败回滚。
- SHA-256 实现与 Node 标准库独立对照，包含 UTF-8、多块和填充边界。
- `pnpm test:complex` 在四库全部真实文档上额外验证逻辑树及辅助子树 UID 唯一性、独立重新解析确定性，以及所有 VARIABLE 内容批量改名后 UID 不变。
