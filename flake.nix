{
  description = "Flake for unyt-watchtower: Holochain observability CLI + Cloudflare dashboard";

  inputs = {
    holonix.url = "github:holochain/holonix?ref=main-0.6";

    nixpkgs.follows = "holonix/nixpkgs";
    flake-parts.follows = "holonix/flake-parts";

    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = inputs@{ nixpkgs, flake-parts, rust-overlay, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = builtins.attrNames inputs.holonix.devShells;
      perSystem = { inputs', pkgs, system, ... }: {
        _module.args.pkgs = import nixpkgs {
          inherit system;
          overlays = [ (import rust-overlay) ];
        };

        formatter = pkgs.nixpkgs-fmt;

        devShells.default = pkgs.mkShell {
          packages = (with inputs'.holonix.packages; [
            holochain
            hc
            lair-keystore
          ]) ++ (with pkgs; [
            (rust-bin.fromRustupToolchainFile ./rust-toolchain.toml)
            nodejs_24
            pnpm
            jq
            sqlite
            perl
            pkg-config
            openssl
            llvmPackages_18.libunwind
          ]);

          shellHook = ''
            export PS1='\[\033[1;35m\][watchtower:\w]\$\[\033[0m\] '
            export LIBCLANG_PATH="${pkgs.llvmPackages_18.libclang.lib}/lib"
          '';
        };
      };
    };
}
