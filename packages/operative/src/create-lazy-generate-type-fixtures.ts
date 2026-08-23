import type { GenerateFunction, GenerateResponse } from './types';

const response = { content: 'fixture', toolCalls: [] } satisfies GenerateResponse;

export const namedGenerate: GenerateFunction = () => Promise.resolve(response);

const defaultGenerate: GenerateFunction = () => Promise.resolve(response);

export default defaultGenerate;
