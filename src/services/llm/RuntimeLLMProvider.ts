import type { LLMMessage, LLMProvider } from '../../domain/contracts';

/** Keeps the application/repository alive when settings switch providers. */
export class RuntimeLLMProvider implements LLMProvider {
  constructor(private provider: LLMProvider) {}
  replace(provider: LLMProvider) { this.provider = provider; }
  chat(messages: LLMMessage[], signal?: AbortSignal) {
    return this.provider.chat(messages, signal);
  }
  generateTitle(question: string, answer: string, signal?: AbortSignal) {
    return this.provider.generateTitle(question, answer, signal);
  }
  summarize(messages: LLMMessage[], signal?: AbortSignal) {
    return this.provider.summarize(messages, signal);
  }
}
