/**
 * Gemini schema format (OpenAPI 3.0 subset).
 * @see https://ai.google.dev/gemini-api/docs/function-calling
 */
export interface GeminiSchema {
  type?: string;
  properties?: Record<string, GeminiSchema>;
  required?: string[];
  items?: GeminiSchema;
  enum?: string[];
  description?: string;
  format?: string;
  nullable?: boolean;
  [key: string]: unknown;
}

/**
 * Gemini function declaration.
 * @see https://ai.google.dev/gemini-api/docs/function-calling
 */
export interface GeminiFunctionDeclaration {
  /** The name of the function. */
  name: string;
  /** A description of what the function does. */
  description: string;
  /** The parameters the function accepts, described as an OpenAPI schema. */
  parameters: GeminiSchema;
}

/**
 * Gemini tool definition containing function declarations.
 * Pass this to the model's tools configuration.
 */
export interface GeminiTool {
  functionDeclarations: GeminiFunctionDeclaration[];
}

export interface GeminiFunctionCallPart {
  functionCall: {
    name: string;
    args: Record<string, unknown>;
  };
}

export interface GeminiFunctionResponsePart {
  functionResponse: {
    name: string;
    response: Record<string, unknown>;
  };
}

export interface GeminiTextPart {
  text: string;
}

export interface GeminiInlineDataPart {
  inlineData: {
    mimeType: string;
    data: string;
  };
}

export interface GeminiFileDataPart {
  fileData: {
    mimeType: string;
    fileUri: string;
  };
}

export type GeminiPart =
  | GeminiFileDataPart
  | GeminiFunctionCallPart
  | GeminiFunctionResponsePart
  | GeminiInlineDataPart
  | GeminiTextPart;
