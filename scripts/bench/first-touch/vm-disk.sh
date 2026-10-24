#!/usr/bin/env bash
# scripts/bench/first-touch/vm-disk.sh — give Postgres a data disk whose read
# latency can be set like a network volume (GBRA-156 first-touch lane).
#
#   bash scripts/bench/first-touch/vm-disk.sh create [SIZE_GB]   # loop file -> dm-delay (0 ms) -> ext4 at /pgdata
#   bash scripts/bench/first-touch/vm-disk.sh delay READ_MS [WRITE_MS]
#   bash scripts/bench/first-touch/vm-disk.sh show
#
# The loop device uses direct I/O, so the host page cache never holds Postgres
# pages: every cache miss inside the Postgres container (whose memory limit
# also caps its page cache) reaches the delayed device.
set -euo pipefail
IMG=/var/lib/pgdisk.img DM=pgdelay MNT=/pgdata
case ${1:-} in
  create)
    size=${2:-400}
    sudo modprobe dm-delay
    [ -f $IMG ] || sudo fallocate -l "${size}G" $IMG
    loop=$(sudo losetup --direct-io=on --show -f $IMG)
    sectors=$(sudo blockdev --getsz "$loop")
    echo "0 $sectors delay $loop 0 0 $loop 0 0" | sudo dmsetup create $DM
    sudo mkfs.ext4 -q -E lazy_itable_init=0,lazy_journal_init=0 /dev/mapper/$DM
    sudo mkdir -p $MNT && sudo mount -o noatime /dev/mapper/$DM $MNT
    sudo mkdir -p $MNT/pg && sudo chmod 777 $MNT/pg
    echo "$loop $sectors" | sudo tee /var/lib/pgdisk.loop >/dev/null
    ;;
  delay)
    read -r loop sectors < /var/lib/pgdisk.loop
    r=${2:?READ_MS} w=${3:-0}
    echo "0 $sectors delay $loop 0 $r $loop 0 $w" | sudo dmsetup load $DM
    sudo dmsetup suspend $DM && sudo dmsetup resume $DM
    sudo dmsetup table $DM
    ;;
  show) sudo dmsetup table $DM ;;
  *) echo "usage: vm-disk.sh create [GB] | delay READ_MS [WRITE_MS] | show" >&2; exit 2 ;;
esac
