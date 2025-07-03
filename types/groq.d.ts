declare module '@groq/groq' {
  export interface ChatMessage {
    role: string;
    content: string;
  }

  export interface ChatCompletionChoice {
    message: {
      content: string;
      role: string;
    };
    index: number;
    finish_reason: string;
  }

  export interface ChatCompletionResponse {
    id: string;
    object: string;
    created: number;
    model: string;
    choices: ChatCompletionChoice[];
  }

  export interface ChatCompletionOptions {
    model: string;
    messages: ChatMessage[];
    temperature?: number;
    max_tokens?: number;
    top_p?: number;
    stream?: boolean;
  }

  export class Groq {
    constructor(options: { apiKey: string });
    
    chat: {
      completions: {
        create(options: ChatCompletionOptions): Promise<ChatCompletionResponse>;
      };
    };
  }
} 