import type { LLMMessage, LLMProvider } from '../../domain/contracts';

function pause(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function answerFor(question: string): string {
  if (/sqrt|缩放|除以|点积/i.test(question)) {
    return '**核心直觉**\n\n如果 query 和 key 的各维近似独立、均值为 0、方差为 1，那么它们的点积方差约为维度 d。除以 √d 可以让分数的尺度更稳定。\n\n未经缩放的分数在维度增大时容易让 softmax 过度集中，导致梯度变小。缩放不是让向量“更相似”，而是控制送入 softmax 的数值范围。\n\n**可以继续探索**\n\n- softmax 为什么在输入绝对值很大时容易饱和？\n- 如果 Q 与 K 的方差不为 1，这个直觉如何变化？';
  }
  if (/q\s*[\/、和与]?\s*k|query|key|attention|注意力/i.test(question)) {
    return '**Q、K、V 的三个角色**\n\n- **Query（Q）**：当前位置想寻找什么信息。\n- **Key（K）**：每个位置用什么特征来匹配查询。\n- **Value（V）**：匹配后实际聚合的信息。\n\nQ 与 K 的点积经缩放、softmax 后得到注意力权重，再对 V 加权求和。三组不同的可学习投影，让“如何匹配”和“传递什么内容”可以分别学习。\n\n**继续沿这条分支思考**\n\nQ 与 K 使用不同投影时，位置 A 对 B 的关注不必等于 B 对 A 的关注。这种非对称性适合语言中的不同角色。';
  }
  if (/位置|position/i.test(question)) {
    return '**为什么还需要顺序信息？**\n\n仅靠自注意力的内容匹配，模型无法直接知道词的排列顺序。位置编码给 token 表示补充位置或相对距离信息。\n\n原始 Transformer 使用正弦/余弦位置编码，也可以学习位置向量。后来的相对位置方法和 RoPE 用不同方式把相对距离融入注意力计算。\n\n你可以继续问：绝对位置与相对位置编码分别有什么局限？';
  }
  return '**先建立一个探索框架**\n\n这是一个预设的学习示例，而不是对当前问题的真实推理。你可以先明确概念的定义，再寻找一个具体例子，最后检查它的适用条件与边界。\n\n**下一步**\n\n1. 从这个节点继续追问一个更小的问题。\n2. 回到上游节点，创建另一个探索分支。\n3. 使用左侧搜索重新定位这次问答。\n\n配置真实 OpenAI-compatible 模型后，回答会使用当前节点的祖先路径作为上下文，不混入兄弟分支。';
}

/** Deliberately local and deterministic; no suggestion that these are model-generated facts. */
export class MockLLMProvider implements LLMProvider {
  constructor(private readonly delayMs = 30) {}

  async *chat(messages: LLMMessage[], signal?: AbortSignal): AsyncIterable<string> {
    const question = messages.filter(message => message.role === 'user').at(-1)?.content ?? '';
    const answer = '> Mock 演示：以下为预设内容，不是真实模型推理。\n\n' + answerFor(question);
    const points = Array.from(answer);
    for (let index = 0; index < points.length; index += 12) {
      await pause(this.delayMs, signal);
      yield points.slice(index, index + 12).join('');
    }
  }

  async generateTitle(question: string, _answer: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (/sqrt|缩放|除以/i.test(question)) return 'Attention 为什么缩放';
    if (/q\s*[\/、和与]?\s*k/i.test(question)) return 'Q 与 K 的不同角色';
    if (/位置|position/i.test(question)) return '位置编码的作用';
    return Array.from(question.trim().replace(/[。！？!?\n]/g, '')).slice(0, 15).join('') || '新的知识探索';
  }

  async summarize(messages: LLMMessage[], signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const questions = messages.filter(message => message.role === 'user').map(message => message.content.trim());
    return 'Mock 摘要（非真实推理）：' + Array.from(questions.join(' → ')).slice(0, 160).join('');
  }
}
