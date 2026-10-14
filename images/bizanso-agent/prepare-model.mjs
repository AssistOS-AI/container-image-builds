import assert from 'node:assert/strict';
import { inputs, loadModel } from './model.mjs';

const extractor = await loadModel({ offline: false });
try {
    const result = await extractor('query: Prepare the runtime embedding model.', { pooling: 'mean', normalize: true });
    assert.equal(result.data.length, inputs.model.dimensions);
    assert.ok(Array.from(result.data).every(Number.isFinite));
    console.log(JSON.stringify({ ready: true, model: inputs.model, dimensions: result.data.length }));
} finally {
    await extractor.dispose();
}
