import assert from 'node:assert/strict';
import test from 'node:test';
import { createContract, requiredVersions, toolPaths } from '../images/robo-work-worker/environment-contract.mjs';

function elf(names) {
    const bytes = Buffer.alloc(1024);
    bytes.write('7f454c46', 0, 'hex'); bytes[4] = 2; bytes[5] = 1;
    bytes.writeBigUInt64LE(64n, 40); bytes.writeUInt16LE(64, 58); bytes.writeUInt16LE(3, 60);
    bytes.writeUInt32LE(3, 132); bytes.writeBigUInt64LE(512n, 152); bytes.writeBigUInt64LE(256n, 160);
    bytes.writeUInt32LE(0x6ffffffe, 196); bytes.writeBigUInt64LE(256n, 216);
    bytes.writeBigUInt64LE(BigInt(16 + names.length * 16), 224); bytes.writeUInt32LE(1, 232);
    bytes.writeUInt16LE(1, 256); bytes.writeUInt16LE(names.length, 258); bytes.writeUInt32LE(16, 264);
    let string = 1;
    for (const [i, name] of names.entries()) {
        bytes.write(name, 512 + string); bytes.writeUInt32LE(string, 280 + i * 16);
        if (i + 1 < names.length) bytes.writeUInt32LE(16, 284 + i * 16);
        string += name.length + 1;
    }
    return bytes;
}

test('contract takes highest required GLIBC numerically and retains C++ requirements', () => {
    const binary = elf(['GLIBC_2.9', 'GLIBC_2.34', 'GLIBCXX_3.4.30', 'CXXABI_1.3.13']);
    // An unrelated exported/string-table value must not raise the required floor.
    binary.write('GLIBC_9.99', 900);
    const contract = createContract((file) => Object.values(toolPaths).includes(file) ? binary : Buffer.from('script'), 'x64');
    assert.equal(contract.glibcFloor, '2.34');
    assert.deepEqual(contract.glibcxxVersions, ['3.4.30']);
    assert.deepEqual(contract.cxxabiVersions, ['1.3.13']);
    assert.equal(contract.architecture, 'amd64');
    assert.equal(createContract(() => binary, 'arm64').architecture, 'arm64');
});

test('ELF requirements reject malformed input and contract refuses missing tools', () => {
    for (const bytes of [Buffer.alloc(0), Buffer.from('not ELF'), elf(['GLIBC_2.34']).subarray(0, 300)]) {
        assert.throws(() => requiredVersions(bytes));
    }
    const corrupt = elf(['GLIBC_2.34']); corrupt.writeUInt32LE(9999, 280);
    assert.throws(() => requiredVersions(corrupt), /version name/);
    assert.throws(() => createContract(() => elf(['GLIBCXX_3.4.30'])), /no GLIBC/);
    for (const version of ['GLIBC_ABI_DT_RELR', 'GLIBCXX_DEBUG_MESSAGE_LENGTH', 'CXXABI_FLOAT128']) {
        assert.throws(() => createContract(() => elf(['GLIBC_2.34', version])), /unsupported-version/);
    }
    assert.throws(() => createContract(() => { throw new Error('missing executable'); }), /missing executable/);
    assert.throws(() => createContract(() => elf(['GLIBC_2.34']), 'riscv64'), /unsupported architecture/);
});
