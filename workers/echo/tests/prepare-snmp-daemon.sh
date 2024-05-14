#!/bin/sh

set -e

cat >/etc/net-snmp/snmp/snmpd.conf <<ENDL
trap2sink 127.0.0.1 testCommunity
rocommunity public
master agentx
agentXSocket unix:/var/net-snmp/agentx
ENDL

svcadm enable net-snmp
svcadm restart net-snmp

# test connection
snmpget -c public -v 2c 127.0.0.1 sysName.0 >/dev/null
nefadm restart echo && sleep 3
