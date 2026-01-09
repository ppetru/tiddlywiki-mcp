{
  description = "TiddlyWiki MCP Server - Model Context Protocol server for TiddlyWiki";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        # Development shell
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            # Node.js and package manager
            nodejs_22

            # Development tools
            typescript
            nodePackages.typescript-language-server

            # Testing and linting
            nodePackages.eslint
            nodePackages.prettier
          ];

          shellHook = ''
            echo "TiddlyWiki MCP Server - Development Environment"
            echo ""
            echo "Available commands:"
            echo "  npm run build       - Build TypeScript to JavaScript"
            echo "  npm run watch       - Watch for changes and rebuild"
            echo "  npm run test        - Run tests with Vitest"
            echo "  npm run lint        - Lint code with ESLint"
            echo "  npm run format      - Format code with Prettier"
            echo ""
            echo "Transport modes:"
            echo "  MCP_TRANSPORT=stdio npm start  - Run with stdio transport (local dev)"
            echo "  MCP_TRANSPORT=http npm start   - Run with HTTP transport (Nomad)"
            echo ""
          '';
        };

        # Build derivation
        packages.default = pkgs.buildNpmPackage {
          pname = "tiddlywiki-mcp-server";
          version = "1.0.0";

          src = ./.;

          npmDepsHash = "sha256-8HCwM4/R0w0fi38bv4zFxuYjv9TMBbHr671Hhfe8CN8=";

          buildPhase = ''
            npm run build
          '';

          installPhase = ''
            mkdir -p $out/bin $out/lib
            cp -r dist $out/lib/
            cp -r node_modules $out/lib/
            cp package.json $out/lib/

            # Create wrapper script
            cat > $out/bin/tiddlywiki-mcp-server <<EOF
            #!/usr/bin/env bash
            exec ${pkgs.nodejs_22}/bin/node $out/lib/dist/index.js "\$@"
            EOF
            chmod +x $out/bin/tiddlywiki-mcp-server
          '';

          meta = with pkgs.lib; {
            description = "Model Context Protocol server for TiddlyWiki";
            license = licenses.mit;
            platforms = platforms.unix;
          };
        };
      }
    );
}
