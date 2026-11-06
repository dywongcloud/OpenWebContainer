# Contributing to OpenWebContainer

First off, thank you for considering contributing to OpenWebContainer! It's people like you that make OpenWebContainer such a great tool.
For the full user and developer documentation, see the [documentation index](docs/README.md).

## Table of Contents
- [Conduct](#conduct)
- [Project Structure](#project-structure)
- [Development Setup](#development-setup)
- [Development Workflow](#development-workflow)
- [Pull Request Process](#pull-request-process)
- [Commit Guidelines](#commit-guidelines)
- [Testing Guidelines](#testing-guidelines)
- [Documentation](#documentation)

## Conduct

This repository has no CODE_OF_CONDUCT file, and GitHub issues are disabled. Be respectful in contributions and keep discussion in pull requests.

## Project Structure


```bash
open-web-container/
.
├── apps/                      # Application packages
│   └── playground/           # Web-based playground
│       ├── src/             
│       │   ├── components/   # React components
│       │   │   ├── Editor/
│       │   │   ├── FileExplorer/
│       │   │   └── Terminal/
│       │   ├── hooks/       # React hooks
│       │   └── ...
│       └── ...

├── packages/                  # Core packages
│   └── core/                # Main container implementation
│       ├── src/
│       │   ├── filesystem/  # Virtual filesystem implementation
│       │   ├── interfaces/  # TypeScript interfaces
│       │   ├── process/    # Process management
│       │   │   ├── base/
│       │   │   ├── executors/
│       │   │   └── manager/
│       │   └── shell/      # Shell implementation
│       └── ...
└── ...
```

### Key Directories

- `packages/core/`: The main container implementation
  - `filesystem/`: Virtual file system implementation
  - `process/`: Process management and types
  - `shell/`: Shell command implementation
  - `interfaces/`: Core TypeScript interfaces

- `apps/playground/`: Web playground application
  - `components/`: React components
  - `hooks/`: Custom React hooks

## Development Setup

1. **Prerequisites**
   - Node.js v24.15.0 (the host version used by the differential compatibility harness; no `engines` field, `.nvmrc` or `.node-version` pins a floor)
   - pnpm (v8 or higher)
   - Git

2. **Initial Setup**
   ```bash
   # Clone the repository
   git clone https://github.com/dywongcloud/OpenWebContainer.git
   cd OpenWebContainer

   # Install dependencies
   pnpm install
   ```

3. **Development Commands**
   ```bash
   # Start development of all packages
   pnpm dev

   # Start only the playground
   pnpm playground

   # Build all packages
   pnpm build

   # Run the package test suites
   pnpm -r test

   # Lint the packages
   pnpm -r lint
   ```

## Development Workflow

1. **Create a new branch**
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes**
   - Write code
   - Add tests
   - Update documentation
   - Run tests locally

3. **Commit your changes**
   We use conventional commits. Format your commit messages as:
   ```
   type(scope): description

   [optional body]

   [optional footer]
   ```
   Types:
   - feat: New feature
   - fix: Bug fix
   - docs: Documentation
   - chore: Maintenance
   - refactor: Code restructuring
   - test: Adding tests
   - style: Formatting

4. **Create a Pull Request**

## Pull Request Process

1. Ensure your code follows our style guide and passes all tests
2. Update documentation if needed
3. Add tests for new features
4. Ensure the PR description clearly describes the problem and solution
5. Note any related documentation in the PR description

## Commit Guidelines

We use [Conventional Commits](https://www.conventionalcommits.org/). Each commit message should be structured as:

```
type(scope): description

[optional body]

[optional footer]
```

Examples:
```
feat(shell): add pipe operator support
fix(filesystem): correct path resolution
docs(readme): update installation instructions
```

## Testing Guidelines

1. **Write tests for new features**
   ```typescript
   describe('VirtualFileSystem', () => {
     it('should create directories', () => {
       // Test code
     });
   });
   ```

2. **Run the package tests before submitting PR**
   ```bash
   pnpm --filter @open-web-container/core test
   ```

3. **Ensure good test coverage**
   - Unit tests for utilities
   - Integration tests for features
   - End-to-end tests for workflows

## Documentation

1. **Code Documentation**
   - Use JSDoc comments for functions and classes
   - Explain complex logic
   - Add usage examples

2. **README Updates**
   - Keep installation instructions updated
   - Document new features
   - Update API references

3. **Example Updates**
   - Add examples for new features
   - Keep existing examples up to date

## Adding New Features

1. **Core Package**
   - Add new features in appropriate directories
   - Update interfaces if needed
   - Add tests
   - Update documentation

2. **Playground**
   - Add new components in `apps/playground/src/components`
   - Update playground to showcase new features
   - Ensure responsive design

## Debugging

1. **Core Package**
   ```typescript
   // Enable debug logs with the real ContainerOptions.debug flag
   import { OpenWebContainer } from '@open-web-container/core';
   const core = new OpenWebContainer({ debug: true });
   ```

2. **Playground**
   - Use React DevTools
   - Check console logs
   - Use browser debugger

## Questions?

If you have questions, please:
1. Check the [documentation index](docs/README.md)
2. Read the [API reference](docs/api.md) and [compatibility notes](docs/reference/compatibility-notes.md); issues are disabled on this repository.

Thank you for contributing! 🎉
