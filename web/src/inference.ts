export const nearModel = 'deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated';
export const veniceModel = 'deepseek-v4-1-flash-1017-uncensored';

export function modelLabel(model: string | null | undefined): string {
  if (model === nearModel) return 'NEAR AI · DeepSeek V4.1 Flash';
  if (model === veniceModel) return 'Venice · DeepSeek V4.1 Flash';
  return model || 'Not reported';
}

export function providerFor(model: string): string | undefined {
  return ({
    'abliterated-model-large-v2': 'abliteration.ai',
    'abliteration-abliterated-model-large-v2': 'venice.ai',
    [nearModel]: 'near.ai',
    [veniceModel]: 'venice.ai',
  } as Record<string, string>)[model];
}

export function permitsSecondary(primary: string, secondary: string) {
  return primary === nearModel && secondary === veniceModel || primary === veniceModel && secondary === nearModel;
}
