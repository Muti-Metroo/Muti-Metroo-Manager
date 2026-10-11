import { describe, expect, it } from 'vitest';
import { buildEntryConfigYaml } from '../yaml';
import { initialEntryWizardState } from '../state';

describe('buildEntryConfigYaml', () => {
  it('emits a minimal config (TUN + SOCKS5 only)', () => {
    // autoroutes defaults on; turn it off here to exercise the bare path.
    const yaml = buildEntryConfigYaml({ ...initialEntryWizardState(), autoroutesEnabled: false });
    expect(yaml).toMatch(/tun:\n {2}name: mutiauk {2}# .*utun/);
    expect(yaml).toMatch(/ {2}mtu: 1400\n {2}address: 10\.200\.200\.1\/24/);
    expect(yaml).toMatch(/socks5:\n {2}server: 127\.0\.0\.1:1080/);
    expect(yaml).not.toMatch(/address6:/);
    expect(yaml).not.toMatch(/routes:/);
    expect(yaml).not.toMatch(/autoroutes:/);
    expect(yaml).not.toMatch(/logging:/);
    expect(yaml).not.toMatch(/username:/);
    expect(yaml).not.toMatch(/password:/);
    expect(yaml).not.toMatch(/transport:/);
    // admin defaults (enabled, 127.0.0.1:48088) → section omitted.
    expect(yaml).not.toMatch(/admin:/);
  });

  it('includes IPv6 only when enabled', () => {
    const yaml = buildEntryConfigYaml({
      ...initialEntryWizardState(),
      tunIPv6Enabled: true,
    });
    expect(yaml).toMatch(/address6: fd00:200::1\/64/);
  });

  it('emits auth block only when enabled', () => {
    const authYaml = buildEntryConfigYaml({
      ...initialEntryWizardState(),
      socks5AuthEnabled: true,
      socks5Username: 'admin',
      socks5Password: 'hunter2',
    });
    expect(authYaml).toMatch(/username: admin/);
    expect(authYaml).toMatch(/password: hunter2/);

    const noAuth = buildEntryConfigYaml({
      ...initialEntryWizardState(),
      socks5Username: 'admin',
      socks5Password: 'hunter2',
    });
    expect(noAuth).not.toMatch(/username:/);
    expect(noAuth).not.toMatch(/password:/);
  });

  it('emits websocket transport only when chosen', () => {
    const ws = buildEntryConfigYaml({
      ...initialEntryWizardState(),
      socks5Transport: 'websocket',
      socks5WSPath: '/custom',
    });
    expect(ws).toMatch(/transport: websocket/);
    expect(ws).toMatch(/ws_path: \/custom/);

    const tcp = buildEntryConfigYaml(initialEntryWizardState());
    expect(tcp).not.toMatch(/transport: websocket/);
    expect(tcp).not.toMatch(/ws_path:/);
  });

  it('omits ws_path when it matches the default', () => {
    const yaml = buildEntryConfigYaml({
      ...initialEntryWizardState(),
      socks5Transport: 'websocket',
    });
    expect(yaml).toMatch(/transport: websocket/);
    expect(yaml).not.toMatch(/ws_path:/);
  });

  it('emits routes with enabled=false preserved', () => {
    const yaml = buildEntryConfigYaml({
      ...initialEntryWizardState(),
      routes: [
        { _id: 'a', destination: '10.0.0.0/8', comment: 'priv-A', enabled: true },
        { _id: 'b', destination: '192.168.0.0/16', comment: '', enabled: false },
      ],
    });
    expect(yaml).toMatch(
      /routes:\n {2}- destination: 10\.0\.0\.0\/8\n {4}enabled: true\n {4}comment: priv-A/,
    );
    expect(yaml).toMatch(/- destination: 192\.168\.0\.0\/16\n {4}enabled: false/);
  });

  it('emits single-endpoint autoroutes only when enabled', () => {
    const enabled = buildEntryConfigYaml({
      ...initialEntryWizardState(),
      autoroutesEnabled: true,
    });
    // Route/host state rides the SOCKS5 route-watch stream: `enabled` is the
    // only knob — no source/url/token/poll_interval (no such config keys exist).
    expect(enabled).toMatch(/autoroutes:\n {2}enabled: true/);
    expect(enabled).not.toMatch(/source:/);
    expect(enabled).not.toMatch(/url:/);
    expect(enabled).not.toMatch(/token:/);
    expect(enabled).not.toMatch(/poll_interval:/);

    // On by default (matches Mutiauk's own setup wizard).
    expect(buildEntryConfigYaml(initialEntryWizardState())).toMatch(
      /autoroutes:\n {2}enabled: true/,
    );

    const disabled = buildEntryConfigYaml({
      ...initialEntryWizardState(),
      autoroutesEnabled: false,
    });
    expect(disabled).not.toMatch(/autoroutes:/);
  });

  it('emits admin only as deltas from the Mutiauk defaults', () => {
    // Disabled → enabled: false (the meaningful delta; default is enabled).
    const off = buildEntryConfigYaml({
      ...initialEntryWizardState(),
      adminEnabled: false,
    });
    expect(off).toMatch(/admin:\n {2}enabled: false/);
    expect(off).not.toMatch(/listen:/);

    // Custom loopback listen → listen only (enabled stays default true).
    const custom = buildEntryConfigYaml({
      ...initialEntryWizardState(),
      adminListen: '127.0.0.1:9090',
    });
    expect(custom).toMatch(/admin:\n {2}listen: 127\.0\.0\.1:9090/);
    expect(custom).not.toMatch(/admin:\n {2}enabled:/);

    // Defaults → no admin section.
    expect(buildEntryConfigYaml(initialEntryWizardState())).not.toMatch(/admin:/);
  });

  it('trims route destinations and drops blank rows', () => {
    const yaml = buildEntryConfigYaml({
      ...initialEntryWizardState(),
      routes: [
        { _id: 'a', destination: '  10.0.0.0/8  ', comment: '', enabled: true },
        { _id: 'b', destination: '   ', comment: 'blank — should be dropped', enabled: true },
      ],
    });
    expect(yaml).toMatch(/- destination: 10\.0\.0\.0\/8/);
    expect(yaml).not.toMatch(/destination: {3,}/);
    expect(yaml).not.toMatch(/blank — should be dropped/);
  });

  it('emits logging only for non-default values', () => {
    const yaml = buildEntryConfigYaml({
      ...initialEntryWizardState(),
      logLevel: 'debug',
      logFormat: 'console',
    });
    expect(yaml).toMatch(/logging:\n {2}level: debug\n {2}format: console/);

    const defaults = buildEntryConfigYaml(initialEntryWizardState());
    expect(defaults).not.toMatch(/logging:/);
  });
});
