#!/usr/bin/env bash
# Swap-файл для сервера: у машины по умолчанию swap нет, а импорт выгрузки OSM пиково ест память.
# Без swap ядро убивает процесс при первом же пике (OOM-killer), то есть плановое обновление падало бы.
set -euo pipefail

SIZE="${SIZE:-2G}"
SWAPFILE="/swapfile"

if swapon --show | grep -q "$SWAPFILE"; then
    echo "swap уже включён:"
    swapon --show
    exit 0
fi

if [ ! -f "$SWAPFILE" ]; then
    echo "создаю swap-файл $SIZE"
    fallocate -l "$SIZE" "$SWAPFILE" || dd if=/dev/zero of="$SWAPFILE" bs=1M count=2048 status=none
    chmod 600 "$SWAPFILE"
    mkswap "$SWAPFILE"
fi

swapon "$SWAPFILE"

# Постоянная настройка: swap и разумный swappiness (по умолчанию 60 — для сервиса с БД многовато).
# На современных Ubuntu /etc/sysctl.conf может отсутствовать, поэтому пишем в sysctl.d.
if ! grep -q "^$SWAPFILE" /etc/fstab; then
    echo "$SWAPFILE none swap sw 0 0" >> /etc/fstab
fi
SYSCTL_FILE="/etc/sysctl.d/99-geopuls.conf"
if ! grep -qs '^vm.swappiness' "$SYSCTL_FILE"; then
    echo 'vm.swappiness=10' >> "$SYSCTL_FILE"
fi
sysctl -q vm.swappiness=10

echo
echo "итог:"
free -m | sed 's/^/  /'
swapon --show | sed 's/^/  /'
grep -q "^$SWAPFILE" /etc/fstab && echo "  автовключение при загрузке: да"
