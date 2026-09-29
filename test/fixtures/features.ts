/**
 * SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
 * SPDX-License-Identifier: MIT
 */

export type FeatureSupport = { supported: boolean; reason?: string };
type Probe = () => Promise<FeatureSupport>;

export class FeatureDetector<Name extends string> {
  private results = new Map<Name, Promise<FeatureSupport>>();
  private probes: Record<Name, Probe>;
  constructor(probes: Record<Name, Probe>) { this.probes = probes; }

  check(name: Name): Promise<FeatureSupport> {
    let result = this.results.get(name);
    if (!result) {
      result = Promise.resolve().then(this.probes[name]);
      this.results.set(name, result);
    }
    return result;
  }

  async require(context: { skip: (condition: boolean, note?: string) => void }, ...names: Name[]): Promise<void> {
    for (const name of names) {
      const result = await this.check(name);
      context.skip(!result.supported, `${name}: ${result.reason ?? "unsupported"}`);
    }
  }
}
