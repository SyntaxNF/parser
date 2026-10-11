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
6. 对每棵最终树执行后序深度优先遍历，先计算 QUOTED / OPTIONAL / GROUP 的局部特征。
7. 按入口顺序、定义声明顺序，使用一个文档会话执行前序深度优先遍历，分配最终节点的 uid/name。
8. 将 REFERENCE.target 绑定到已生成的定义根 UID。

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
| QUOTED / OPTIONAL / GROUP | 直接子节点特征数组的四位大写 Base36 哈希 |
| ROOT | null，不寻找名称 |
| 引号内 BLANK / WRAP | `[类型码,content]` |
| 引号外 BLANK / WRAP | null |

COLLECTION 与其被替换的变量一样，使用调用位置的功能标识；定义体的新关键字不会抹去调用位置的祖先哈希。例如 `SELECT item FROM item` 中，即使 item 的定义都是 `VALUE x`，两个调用及其内部节点在整段换序后仍各自保持 ID。

### QUOTED / OPTIONAL / GROUP 统一局部特征

三类节点共用同一套直接子级提取与压缩规则。顺序保留，不排序、不去重，也不区分第一个与后续定义：

| 直接子节点 | 提供给父节点的特征 |
| --- | --- |
| DEFINITION | `['D', content]`，完整解码文本 |
| NUMBER | `['N', content]`，完整文本，不转数值 |
| QUOTED | `['Q', quote, 子节点已经生成的四位局部特征]` |
| 引号外 BLANK / WRAP | 忽略 |
| 引号内 BLANK / WRAP | `['SPACE', content]` |
| 引号内 OTHER | `['TEXT', content]`，包括 SQL 成对转义引号及其他固定符号 |
| 其他类型 | `['T', 类型名称首字母]`，例如 VARIABLE→V、ENUM→E、LOOP→L、COLLECTION→C、OPTIONAL / 引号外 OTHER→O |

变量名、变量值、helper 名、name、UID、源码位置不参与局部特征。类别标签区分固定定义 `V` 与变量类型 V、固定数字与其他文本。父节点不访问孙节点；普通容器的内容不向父级暴露，QUOTED 只提供已算好的短码和引号类型。父节点也不使用子节点 UID 或同前缀序号。

短码协议：对直接子级特征数组的 JSON 编码做 UTF-8 SHA-256，将完整 256 位摘要按无符号大端整数取模 `36⁴ = 1,679,616`，转大写 Base36，左侧补 0 到 4 位。每个容器压缩一次，不对内部各个定义单独做短哈希。空容器使用 `[]` 的哈希，不返回 null。浏览器与 Node 使用同一算法，不依赖外部名称表或历史结果。

例如：

```text
'Y' 的输入特征：[["D","Y"]] → 局部特征 C4GQ
'N' 的输入特征：[["D","N"]] → 局部特征 C3XW

[ DEFAULT 'Y' value ] 的输入特征：
[["D","DEFAULT"],["Q","'","C4GQ"],["T","V"]]
再整体压成该 OPTIONAL 自己的四位局部特征。
```

“不读取孙节点”不等于完全不受其影响：QUOTED 内容改变会改变它提供的短码，进而影响直接父级。普通 OPTIONAL、ENUM、LOOP 等子节点仍只贡献类型，不传递内部内容。

### 两次深度优先遍历

1. **后序阶段**：进入节点时传递引号上下文；子节点处理完成后，当前节点只读取第一层子节点的内容、类型和已经生成的 QUOTED 局部特征，记录压缩前签名及四位短码。
2. **前序阶段**：读取预先算好的局部特征，结合父级功能路径分配 UID，同时按 DEFINITION 作用域生成 name。

两阶段都使用显式栈，避免深层 AST 的 JavaScript 调用栈溢出。局部特征表仅存在于本次解析中，不向 AST 增加中间字段，不改变一次 parse 返回最终结果的接口。

交换 `[ [ A a ] [ B b ] ]` 的两个内层 OPTIONAL，外层输入始终是 `[['T','O'],['T','O']]`；内层不同功能节点可保持各自 UID。将 `[ A [ B b ] ]` 改成 `[ [ B b ] A ]` 则改变外层特征顺序，UID 可以改变。对少数 SQL 中合法且等价的参数换序，不做额外的无序化处理。引号外不同 OTHER 符号也可能得到相同特征，由碰撞检测报告。

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

### 功能特征碰撞诊断

`findIdentityCollisions(rootOrRoots)` 检查一份最终 AST / 同一文档全部根中的 QUOTED / OPTIONAL / GROUP，按实际 UID 前三段分组，报告仍需序号区分的位置。检测只读，不改变 UID、不阻断解析；短码重复不等于 128 位路径哈希碰撞。

- `short-hash`：同一完整前缀下，当前节点压缩前的直接子级签名不同，说明当前节点的四位压缩引入碰撞。
- `same-signature`：当前节点的直接子级签名相同，例如两个纯变量分支、只含不同 ENUM 的可选项、相同定义的重复展开实例，或子 QUOTED 碰撞传递上来的相同短码。

每项包含 `prefix` 和 `occurrences`，后者给出 uid、sourceBlock、start/end、raw 及当前节点压缩前的直接子级 `fullSignature`（其中 QUOTED 仍为子节点短码）。不同父级功能路径、不同类型或深度不会仅因短码相同而被报告；父级相同功能路径的重复实例仍共用前缀计数，不能只检查同一个父节点对象的兄弟节点。传入全部 entries 和 definitions 能覆盖整个文档会话；不要混入其他文档或其他解析调用的根。

同一根对象重复传入只遍历一次。检测要求所有节点具有最终 UID；不同节点对象出现完全相同 UID 时，按无效输入报错，不伪装成普通特征碰撞。这通常意味着混入独立解析会话的根，或 AST 的 UID 已被修改。该检查无法证明没有相同 UID 的输入一定来自同一会话，调用方仍需遵守单会话约定。分类针对当前节点自身的压缩步骤；QUOTED 短码碰撞向父级传递时，父级可能报告 same-signature，而 QUOTED 自身报告 short-hash。无需在父级诊断时递归展开孙节点。祖先路径碰撞则在对应祖先的报告中定位。

在均匀分布假设下，两个不同局部签名的 4 位 Base36 短码碰撞概率为 `1 / 1,679,616`，约 `0.0000595%`；20 个不同局部签名中至少一对碰撞约 `0.0113%`。短码相同且类型、深度、父级功能路径及引号上下文等前缀输入也相同时，才会导致完整前缀重复。哈希容量有限，不能承诺绝对无碰撞；完整前缀重复时按序号保证唯一性，换序仍可能改变对应 UID。

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

`pnpm test:uid` 同时运行 QUOTED / OPTIONAL / GROUP 稳定性回归：重排、插入、变量/helper 改名、多个定义、数字、引号定界符、固定符号与内部空白，以及真实四位容器短码碰撞的诊断和序号回退。`pnpm test:complex` 对四库逐文档执行碰撞检测；输出相同特征前缀的数量，遇到四位压缩碰撞则失败并报告来源。
