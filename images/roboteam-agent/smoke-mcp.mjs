import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

// Exercise protocol readiness without invoking any desktop tool or requiring a display.
export async function smokeMcp(command, args, version, timeout = 30000) {
    await new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        let pending = '';
        let stderr = '';
        let initialized = false;
        let listed = false;
        let failure;
        const fail = (error) => {
            failure ||= error;
            child.kill('SIGKILL');
        };
        const timer = setTimeout(() => fail(new Error('MCP smoke timed out')), timeout);
        const send = (frame) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`);
        child.on('error', fail);
        child.stdin.on('error', fail);
        child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8192); });
        child.stdout.on('data', (chunk) => {
            try {
                pending += chunk;
                assert.ok(pending.length <= 1024 * 1024, 'MCP output exceeds smoke limit');
                let newline;
                while ((newline = pending.indexOf('\n')) !== -1) {
                    const frame = JSON.parse(pending.slice(0, newline));
                    pending = pending.slice(newline + 1);
                    assert.equal(frame.jsonrpc, '2.0');
                    assert.equal(frame.error, undefined, 'MCP returned an error');
                    if (frame.id === 1) {
                        assert.equal(initialized, false, 'Duplicate initialize response');
                        assert.equal(frame.result.protocolVersion, '2025-06-18');
                        assert.equal(frame.result.serverInfo.name, 'computer-use-linux');
                        assert.equal(frame.result.serverInfo.version, version);
                        initialized = true;
                        send({ method: 'notifications/initialized' });
                        send({ id: 2, method: 'tools/list', params: {} });
                    } else if (frame.id === 2) {
                        assert.ok(initialized && !listed, 'Unexpected tools response');
                        assert.ok(Array.isArray(frame.result.tools) && frame.result.tools.length > 0, 'Empty MCP tool catalog');
                        assert.ok(frame.result.tools.some((tool) => tool.name === 'get_app_state'), 'Desktop tool missing');
                        listed = true;
                        child.stdin.end();
                    }
                }
            } catch (error) {
                fail(error);
            }
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (failure) return reject(failure);
            if (code !== 0 || !listed) return reject(new Error(`MCP smoke exited ${code} before successful completion: ${stderr}`));
            resolve();
        });
        send({ id: 1, method: 'initialize', params: {
            protocolVersion: '2025-06-18', capabilities: {},
            clientInfo: { name: 'image-payload-smoke', version: '1.0.0' },
        } });
    });
}
