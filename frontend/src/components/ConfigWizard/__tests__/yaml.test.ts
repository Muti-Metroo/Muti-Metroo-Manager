import { describe, expect, it } from 'vitest';
import { buildConfigYaml } from '../yaml';
import { initialWizardState } from '../state';

describe('buildConfigYaml', () => {
  it('emits a minimal config with defaults (everything off)', () => {
    const state = {
      ...initialWizardState(),
      displayName: 'relay-01',
      listenerTransport: 'quic' as const,
      listenAddress: '0.0.0.0:4433',
    };
    const yaml = buildConfigYaml(state);
    expect(yaml).toMatch(/agent:\n/);
    expect(yaml).toMatch(/display_name: relay-01/);
    expect(yaml).toMatch(/data_dir: (.*)/);
    expect(yaml).toMatch(/listeners:\n/);
    expect(yaml).toMatch(/- transport: quic/);
    expect(yaml).toMatch(/address: 0\.0\.0\.0:4433/);
    expect(yaml).not.toMatch(/http:\n/);
    expect(yaml).not.toMatch(/management:/);
    expect(yaml).not.toMatch(/peers:/);
    expect(yaml).not.toMatch(/shell:/);
    expect(yaml).not.toMatch(/file_transfer:/);
    expect(yaml).not.toMatch(/socks5:/);
    expect(yaml).not.toMatch(/^exit:/m);
  });

  it('omits listeners section when listener is disabled (outbound-only agent)', () => {
    const state = { ...initialWizardState(), listenerEnabled: false };
    const yaml = buildConfigYaml(state);
    expect(yaml).not.toMatch(/listeners:/);
  });

  it('emits the advertise block when an advertise address is set', () => {
    const state = {
      ...initialWizardState(),
      listenerTransport: 'h2' as const,
      listenAddress: '0.0.0.0:3000',
      listenPath: '/mesh',
      advertiseEnabled: true,
      advertiseAddress: 'kreata.ee:3000',
    };
    const yaml = buildConfigYaml(state);
    expect(yaml).toMatch(
      /listeners:\n {2}- transport: h2\n {4}address: 0\.0\.0\.0:3000\n {4}path: \/mesh\n {4}advertise:\n {6}address: kreata\.ee:3000\n {6}path: \/mesh/,
    );
  });

  it('omits the advertise block when address is empty (default state)', () => {
    const state = {
      ...initialWizardState(),
      listenAddress: '0.0.0.0:4433',
      advertiseEnabled: true,
      advertiseAddress: '',
    };
    const yaml = buildConfigYaml(state);
    expect(yaml).toMatch(/listeners:\n {2}- transport: quic\n {4}address: 0\.0\.0\.0:4433/);
    expect(yaml).not.toMatch(/advertise:/);
  });

  it('omits the advertise block when advertiseEnabled is false even with an address set', () => {
    const state = {
      ...initialWizardState(),
      advertiseEnabled: false,
      advertiseAddress: 'kreata.ee:3000',
    };
    const yaml = buildConfigYaml(state);
    expect(yaml).not.toMatch(/advertise:/);
  });

  it('omits advertise.path for quic (no path semantics)', () => {
    const state = {
      ...initialWizardState(),
      listenerTransport: 'quic' as const,
      listenAddress: '0.0.0.0:4433',
      advertiseEnabled: true,
      advertiseAddress: 'mesh.example.com:4433',
    };
    const yaml = buildConfigYaml(state);
    expect(yaml).toMatch(/advertise:\n {6}address: mesh\.example\.com:4433/);
    expect(yaml).not.toMatch(/advertise:[\s\S]*path:/);
  });

  it('emits each feature only when its toggle is on', () => {
    const state = {
      ...initialWizardState(),
      socks5Enabled: true,
      shellEnabled: true,
      fileTransferEnabled: true,
      exitEnabled: true,
      exitRoutes: ['10.0.0.0/8'],
      httpEnabled: true,
    };
    const yaml = buildConfigYaml(state);
    expect(yaml).toMatch(/socks5:\n {2}enabled: true\n {2}address: 127\.0\.0\.1:1080/);
    expect(yaml).toMatch(/shell:\n {2}enabled: true\n {2}whitelist:\n {4}- "\*"/);
    expect(yaml).toMatch(/file_transfer:\n {2}enabled: true\n {2}allowed_paths:\n {4}- "\*"/);
    expect(yaml).toMatch(/exit:\n {2}enabled: true\n {2}routes:\n {4}- 10\.0\.0\.0\/8/);
    expect(yaml).toMatch(/http:\n {2}enabled: true/);
  });

  it('carries seeded shell whitelist through to YAML', () => {
    const state = {
      ...initialWizardState(),
      shellEnabled: true,
      shellWhitelist: ['whoami', 'ls'],
    };
    const yaml = buildConfigYaml(state);
    expect(yaml).toMatch(/shell:\n {2}enabled: true\n {2}whitelist:\n {4}- whoami\n {4}- ls/);
    expect(yaml).not.toMatch(/password_hash:/);
  });

  it('carries seeded file_transfer allowed_paths', () => {
    const state = {
      ...initialWizardState(),
      fileTransferEnabled: true,
      fileTransferAllowedPaths: ['/tmp', '/home/*/uploads'],
    };
    const yaml = buildConfigYaml(state);
    expect(yaml).toMatch(
      /file_transfer:\n {2}enabled: true\n {2}allowed_paths:\n {4}- \/tmp\n {4}- \/home\/\*\/uploads/,
    );
    expect(yaml).not.toMatch(/password_hash:/);
  });

  it('includes management public keys when public_only', () => {
    const state = {
      ...initialWizardState(),
      mgmtMode: 'public_only' as const,
      mgmtPublicKey: 'a'.repeat(64),
      mgmtSigningPublicKey: 'c'.repeat(64),
    };
    const yaml = buildConfigYaml(state);
    expect(yaml).toMatch(/management:\n {2}public_key: aaaa/);
    expect(yaml).toMatch(/signing_public_key: cccc/);
    expect(yaml).not.toMatch(/private_key:/);
  });

  it('includes management private and signing keys in operator mode', () => {
    const state = {
      ...initialWizardState(),
      mgmtMode: 'operator' as const,
      mgmtPublicKey: 'a'.repeat(64),
      mgmtPrivateKey: 'b'.repeat(64),
      mgmtSigningPublicKey: 'c'.repeat(64),
      mgmtSigningPrivateKey: 'd'.repeat(128),
    };
    const yaml = buildConfigYaml(state);
    expect(yaml).toMatch(/public_key: aaaa/);
    expect(yaml).toMatch(/private_key: bbbb/);
    expect(yaml).toMatch(/signing_public_key: cccc/);
    expect(yaml).toMatch(/signing_private_key: dddd/);
    expect(yaml).toMatch(/# WARNING: This config includes management PRIVATE keys/);
  });

  it('omits management entirely in none mode', () => {
    const state = {
      ...initialWizardState(),
      mgmtMode: 'none' as const,
      mgmtPublicKey: 'a'.repeat(64),
      mgmtPrivateKey: 'b'.repeat(64),
      mgmtSigningPublicKey: 'c'.repeat(64),
      mgmtSigningPrivateKey: 'd'.repeat(128),
    };
    const yaml = buildConfigYaml(state);
    expect(yaml).not.toMatch(/management:/);
    expect(yaml).not.toMatch(/private_key:/);
    expect(yaml).not.toMatch(/signing_/);
  });

  it('emits strict TLS block with block-scalar CA PEM', () => {
    const caPem = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----';
    const state = {
      ...initialWizardState(),
      tlsMode: 'strict' as const,
      tlsStrict: true,
      caPem,
    };
    const yaml = buildConfigYaml(state);
    expect(yaml).toMatch(/tls:\n {2}ca_pem: \|\n {4}-----BEGIN CERTIFICATE-----/);
    expect(yaml).toMatch(/strict: true/);
    expect(yaml).not.toMatch(/cert_pem:/);
  });

  it('emits peers with id and http path for h2', () => {
    const state = {
      ...initialWizardState(),
      peers: [
        {
          _id: 'a',
          transport: 'h2' as const,
          address: 'peer.example.com:8443',
          path: '/mesh',
          expectedId: 'f'.repeat(64),
        },
        {
          _id: 'b',
          transport: 'quic' as const,
          address: 'quic.example.com:4433',
          path: '',
          expectedId: '',
        },
      ],
    };
    const yaml = buildConfigYaml(state);
    expect(yaml).toMatch(
      /peers:\n {2}- transport: h2\n {4}address: peer\.example\.com:8443\n {4}id: ffffff/,
    );
    expect(yaml).toMatch(/path: \/mesh/);
    expect(yaml).toMatch(/- transport: quic\n {4}address: quic\.example\.com:4433/);
  });

  it('quotes reserved-looking strings', () => {
    const state = {
      ...initialWizardState(),
      displayName: 'true',
    };
    const yaml = buildConfigYaml(state);
    expect(yaml).toMatch(/display_name: "true"/);
  });

  it('emits token hash when provided; commented-note only when http enabled without hash', () => {
    const withHash = { ...initialWizardState(), httpEnabled: true, httpTokenHash: '$2a$10$abcdef' };
    expect(buildConfigYaml(withHash)).toMatch(/token_hash:/);
    expect(buildConfigYaml(withHash)).not.toMatch(
      /NOTE: HTTP API is enabled without authentication/,
    );

    const enabledNoHash = { ...initialWizardState(), httpEnabled: true };
    expect(buildConfigYaml(enabledNoHash)).toMatch(
      /NOTE: HTTP API is enabled without authentication/,
    );

    const disabled = { ...initialWizardState() };
    expect(buildConfigYaml(disabled)).not.toMatch(/http:\n/);
    expect(buildConfigYaml(disabled)).not.toMatch(
      /NOTE: HTTP API is enabled without authentication/,
    );
  });
});
