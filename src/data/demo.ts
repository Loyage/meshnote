import type { Workspace } from '../domain/contracts';
import { emptyWorkspace } from '../repositories/contracts';

export const DEMO_MESH_ID = 'demo-transformer';

/** Real explanatory text, not a simulated live-model answer. The seed is only
 * installed once by the repository's initialization transaction.
 */
export function createDemoWorkspace(now = new Date().toISOString()): Workspace {
  const entries = [
    {
      id: 'demo-transformer-root', title: 'Transformer 是什么？', question: 'Transformer 是什么？它如何理解序列？',
      answer: 'Transformer 是一种以 **Attention（注意力）** 为核心的神经网络架构。\n\n它让序列中的每个位置根据当前任务，直接读取其他位置的信息，而不必像循环神经网络那样逐步传递状态。\n\n一个典型模块由多头注意力、逐位置前馈网络、残差连接和归一化组成。位置编码补充顺序信息。原始 Transformer 使用编码器—解码器结构；现代语言模型也常使用仅解码器结构。\n\n从下方的分支继续探索：Attention 如何选择信息？Q/K/V 各自承担什么角色？位置又是如何被表示的？',
    },
    {
      id: 'demo-attention', parent: 'demo-transformer-root', title: '什么是 Attention？', question: '什么是 Attention？为什么它能帮助模型理解上下文？',
      answer: 'Attention 可以理解为一次**按相关程度读取信息**的操作。对当前位置的 Query，模型计算它与各个 Key 的匹配分数，再对分数做 softmax，得到非负且和为 1 的权重。\n\n随后用这些权重对 Value 做加权求和：\n\n`Attention(Q, K, V) = softmax(QKᵀ / √dₖ)V`\n\n权重决定“从哪里读取”，Value 决定“读取什么”。自注意力中的 Q、K、V 都来自同一序列的表示，但使用不同的投影矩阵。',
    },
    {
      id: 'demo-qkv', parent: 'demo-attention', title: 'Q/K/V 分别是什么？', question: '为什么 Attention 使用 Q/K/V？三者分别代表什么？',
      answer: '**Q（Query）** 表示当前位置想查找什么；**K（Key）** 表示一个位置如何被匹配；**V（Value）** 表示匹配后要读取的内容。\n\n同一个输入表示 X 经过三个可学习的投影：\n\n- `Q = XW_Q`\n- `K = XW_K`\n- `V = XW_V`\n\nQ 和 K 计算相关性，得到注意力权重；这些权重用于汇总 V。把寻址与内容分开，模型就可以分别学习“什么与什么相关”和“应当传递什么信息”。',
    },
    {
      id: 'demo-qk-separate', parent: 'demo-qkv', title: 'Q 和 K 为什么分开？', question: '既然 Q 和 K 都来自输入，为什么不使用相同的投影？',
      answer: '“我需要什么信息”和“我能提供什么信息”是不同角色，因此 Q 与 K 使用不同的可学习投影。\n\n若共享投影，未加掩码时的自注意力打分矩阵 `QQᵀ` 是对称的。分别学习 Q 和 K 则允许有方向的匹配：A 对 B 的关注，不必等于 B 对 A 的关注。\n\n注意：即便打分对称，逐行 softmax 后的注意力权重也不一定对称。分开 Q/K 是提升表达能力的设计，并非所有注意力变体都必须遵守的数学定理。',
    },
    {
      id: 'demo-dot-product', parent: 'demo-attention', title: '为什么使用点积？', question: '为什么用 Query 和 Key 的点积计算 Attention score？',
      answer: '点积提供了一个简单、可微且高效的匹配函数。学习到的投影把 Query 与 Key 映射到共同的特征空间；某些维度上的共同激活会提高匹配分数。\n\n所有位置的匹配可以写成一次矩阵乘法 `QKᵀ`，非常适合 GPU 并行计算。\n\n点积不等于纯粹的余弦相似度，因为它也受向量长度影响。加性注意力等其他打分函数同样可用，点积是表达力与计算效率之间的一种选择。',
    },
    {
      id: 'demo-scaling', parent: 'demo-attention', title: '为什么除以 √d？', question: '为什么 Attention score 要除以 sqrt(d)？',
      answer: '假设 q 和 k 的各维度近似独立、均值为 0、方差为 1，那么点积是 dₖ 个乘积项之和，其方差约为 dₖ，标准差约为 √dₖ。\n\n如果直接把维度增大后的分数送入 softmax，输出可能过早变得非常尖锐，导致许多位置的梯度很小。\n\n除以 √dₖ 可以把分数尺度控制在更稳定的范围，帮助优化。这里 dₖ 是**单个注意力头的 Key 维度**，不是序列长度。',
    },
    {
      id: 'demo-position', parent: 'demo-transformer-root', title: '为什么需要位置编码？', question: 'Transformer 为什么需要位置编码？',
      answer: '不带位置信息的自注意力对输入位置的排列具有等变性：它能读取内容，却没有直接表达绝对位置或相对距离的机制。\n\n语言、时间序列等任务需要区分顺序，例如“猫追狗”和“狗追猫”。位置编码提供这种顺序信息。\n\n常见做法包括正弦绝对位置编码、可学习位置向量，以及把相对位置信息注入注意力计算的 RoPE 等方法。因果掩码限制可读取的方向，但与显式位置表示承担不同作用。',
    },
    {
      id: 'demo-multi-head', parent: 'demo-transformer-root', title: '多头注意力的意义', question: 'Multi-head Attention 有什么意义？为什么不只用一个头？',
      answer: '多个注意力头分别学习 Q/K/V 投影，在不同的表示子空间中并行读取信息，再把结果拼接并投影回模型维度。\n\n这允许同一个位置同时利用不同的匹配模式，而不必让所有信息都通过一套权重分布。\n\n不能简单地把每个头固定解释成某一种语言学规则：头的功能来自训练，可能重叠或冗余。增加头数也并不保证性能一直提高，需要与总维度和计算预算共同设计。',
    },
  ];
  return {
    ...emptyWorkspace(),
    meshes: [{ id: DEMO_MESH_ID, title: 'Transformer', description: '从注意力机制出发，沿着问题探索 Transformer。', rootNodeId: entries[0].id, createdAt: now, updatedAt: now }],
    nodes: entries.map(entry => ({ id: entry.id, meshId: DEMO_MESH_ID, title: entry.title, userMessage: entry.question, assistantMessage: entry.answer, status: 'completed', createdAt: now, updatedAt: now })),
    edges: entries.filter(entry => entry.parent).map(entry => ({ id: `edge-${entry.id}`, meshId: DEMO_MESH_ID, sourceNodeId: entry.parent!, targetNodeId: entry.id, type: 'branch', createdAt: now })),
  };
}
