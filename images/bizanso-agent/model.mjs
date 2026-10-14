import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AutoTokenizer, AutoModel, FeatureExtractionPipeline, env } from './transformers.mjs';

export const inputs = JSON.parse(readFileSync(new URL('./sources.lock.json', import.meta.url), 'utf8'));
export const cache = '/opt/bizanso-runtime/models';

export async function loadModel({ offline }) {
    env.allowRemoteModels = !offline;
    const options = {
        revision: inputs.model.revision, dtype: inputs.model.dtype, device: 'cpu',
        cache_dir: cache, local_files_only: offline,
        session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
    };
    const source = offline ? resolve(cache, inputs.model.name, inputs.model.revision) : inputs.model.name;
    const tokenizer = await AutoTokenizer.from_pretrained(source, options);
    const model = await AutoModel.from_pretrained(source, options);
    return new FeatureExtractionPipeline({ task: 'feature-extraction', tokenizer, model });
}
