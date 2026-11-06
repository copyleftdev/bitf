# Bundled replay

`coinbase-usd.json.gz` is a deterministic gzip-compressed JSON bundle containing public Coinbase Exchange candle response bodies, source URLs, their original SHA-256 hashes, protocol metadata, and the stored alerts used by Replay.

It preserves the original recorded observations, including missing data. It contains no account credentials, wallet data, or private order information. See [data definitions](../../docs/data.md) for the observation window and limitations.

This fixture is market data, not generated prices. Live mode does not use it for prices or statistics.
