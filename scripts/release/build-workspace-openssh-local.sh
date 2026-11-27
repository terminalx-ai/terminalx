#!/usr/bin/env bash
# Build private workspace OpenSSH payloads in local, preloaded Linux containers.
set -euo pipefail

if [[ $# != 6 ]]; then
  echo "Usage: $0 VERSION SOURCE_TARBALL SOURCE_SHA256 OUTPUT_DIR AMD64_IMAGE ARM64_IMAGE" >&2
  exit 2
fi
version=$1
source_file="$(cd "$(dirname "$2")" && pwd -P)/$(basename "$2")"
source_sha=$3
output="$(cd "$4" && pwd -P)"
amd64_image=$5
arm64_image=$6
tool_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+p[0-9]+(-terminalx\.[0-9]+)?$ ||
      ! -f "$source_file" || ! "$source_sha" =~ ^[a-f0-9]{64}$ ]]; then
  echo "Supply a portable version, pinned source file and lowercase SHA-256 digest." >&2
  exit 2
fi
source_name="openssh-${version%%-terminalx.*}.tar.gz"
if [[ "$(basename "$source_file")" != "$source_name" ]]; then
  echo "Source filename does not match the pinned version." >&2
  exit 2
fi

scratch=$(mktemp -d "$output/.workspace-openssh-build.XXXXXX")
trap 'rm -rf -- "$scratch"' EXIT
mkdir "$scratch/source" "$scratch/artifacts"
cp "$tool_dir/workspace-openssh.py" "$scratch/source/"
cp "$source_file" "$scratch/source/$source_name"

# Stream inputs and outputs so the builders work with a local Docker VM
# without mounting any host directories or forwarding credentials.
build() {
  local platform=$1 arch=$2 image=$3 artifact
  artifact="openssh-$version-linux-$arch.tar.gz"
  COPYFILE_DISABLE=1 tar -cf - -C "$scratch/source" workspace-openssh.py "$source_name" |
    docker run --rm -i --pull never --platform "linux/$platform" --network none       --entrypoint sh "$image" -c '
        set -eu
        version=$1 arch=$2 source=$3 digest=$4 artifact=$5
        cd "$(mktemp -d)"
        tar -xf -
        mkdir artifacts
        python3 workspace-openssh.py build --version "$version" --arch "$arch"           --source "$source" --source-sha256 "$digest" --output artifacts           --library-dir "/usr/lib/$arch-linux-gnu" --library-dir "/lib/$arch-linux-gnu"           --library-dir /usr/lib64 --library-dir /usr/lib --library-dir /lib64 --library-dir /lib >&2
        cat "artifacts/$artifact"
      ' workspace-openssh "$version" "$arch" "$source_name" "$source_sha" "$artifact"       > "$scratch/artifacts/$artifact"
  test -s "$scratch/artifacts/$artifact"
}

build amd64 x86_64 "$amd64_image"
build arm64 aarch64 "$arm64_image"
python3 "$tool_dir/workspace-openssh.py" manifest --version "$version"   --arch x86_64 --arch aarch64 --output "$scratch/artifacts"

# Refuse to replace a previous local build. Publish the manifest last.
for file in "$scratch"/artifacts/*; do
  target="$output/$(basename "$file")"
  [[ ! -e "$target" && ! -L "$target" ]] || {
    echo "Output already exists: $target" >&2
    exit 1
  }
done
for file in "$scratch"/artifacts/*.tar.gz "$scratch/artifacts/manifest.json"; do
  ln -- "$file" "$output/$(basename "$file")"
done
