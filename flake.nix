{
  description = "Ann — the journey-of-legs engine (TypeScript ESM CLI)";

  inputs = {
    # Matches the sibling app flakes (~/Documents/apps/space-fleet, teldrassil)
    # and the channel the ambient bun (1.3.13) already comes from
    # (~/.nix-profile via nixpkgs-unstable in the darwin home config).
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        # Toolchain-only dev shell. bun stays the dependency manager: JS deps
        # are installed from the committed bun.lock into the gitignored
        # node_modules/ (see shellHook). No nix-built artifact — the CLI is
        # dev-run via `bun run build` + `node dist/surface/cli.js`.
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            bun            # dependency manager + script runner (1.3.13)
            nodejs_26      # runtime: `ann` = `node dist/...`, vitest/tsc run under node; matches @types/node ^26
          ];

          shellHook = ''
            # Bootstrap/sync the gitignored dep tree from the committed bun.lock.
            # Runs on a clean checkout, and whenever package.json/bun.lock are
            # newer than node_modules/ (e.g. after a `git pull` that bumped deps).
            # `bun install` is a fast no-op when everything is already current.
            if [ ! -d node_modules ] || [ package.json -nt node_modules ] || [ bun.lock -nt node_modules ]; then
              echo "ann: syncing node_modules from bun.lock..."
              bun install
            fi
            echo "ann: node $(node --version) · bun $(bun --version)"
          '';
        };
      });
}
