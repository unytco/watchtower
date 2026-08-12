{
  description = "Flake for unyt-watchtower: Holochain observability CLI + Cloudflare dashboard";

  inputs = {
    holonix.url = "github:holochain/holonix?ref=main-0.7";

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
            pkgsCross.musl64.stdenv.cc
          ]);

          shellHook = ''
            export PS1='\[\033[1;35m\][watchtower:\w]\$\[\033[0m\] '
            export LIBCLANG_PATH="${pkgs.llvmPackages_18.libclang.lib}/lib"

            # Cross-compile to x86_64-unknown-linux-musl so the observer + CLI
            # produce a fully-static ELF that can be scp'd to non-Nix servers
            # without an /nix/store dependency for the dynamic loader.
            export CC_x86_64_unknown_linux_musl="${pkgs.pkgsCross.musl64.stdenv.cc}/bin/x86_64-unknown-linux-musl-cc"
            export AR_x86_64_unknown_linux_musl="${pkgs.pkgsCross.musl64.stdenv.cc.bintools.bintools}/bin/x86_64-unknown-linux-musl-ar"
            export CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER="$CC_x86_64_unknown_linux_musl"
            export CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_RUSTFLAGS="-C target-feature=+crt-static -C link-self-contained=yes"
          '';
        };
      };
    };
}
