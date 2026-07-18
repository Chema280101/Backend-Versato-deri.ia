import { LLMProvider, LLMResponse, LLMContext } from './llm.provider';

export class MockLLMProvider implements LLMProvider {
  public lastContext?: LLMContext;

  private responsesQueue: LLMResponse[] = [];
  private defaultResponse: LLMResponse = { text: 'Hello from mock LLM!' };

  public setResponse(response: LLMResponse): void {
    this.responsesQueue = [response];
  }

  public pushResponse(response: LLMResponse): void {
    this.responsesQueue.push(response);
  }

  public clearQueue(): void {
    this.responsesQueue = [];
  }

  public async generateResponse(context: LLMContext): Promise<LLMResponse> {
    this.lastContext = context;

    const nextResponse = this.responsesQueue.shift();
    return nextResponse || this.defaultResponse;
  }
}
