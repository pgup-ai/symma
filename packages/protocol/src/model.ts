export interface ParsedModel {
  providerID: string;
  modelID: string;
}

export function parseModelName(model: string): ParsedModel {
  const [providerID, ...rest] = model.trim().split('/');
  const modelID = rest.join('/');
  if (!providerID || !modelID) {
    throw new Error(`Invalid model "${model}"; expected "provider/model".`);
  }
  return { providerID, modelID };
}
