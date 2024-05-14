#!/usr/bin/python
import sys
sys.path.append('../../../extlib/python')

import nef
client = nef.NEFClient('tcp://127.0.0.1:5557')

if len(sys.argv) != 2:
    raise "Please pass only config file as first argument"

f = open(sys.argv[1], 'r')
config = f.read()
f.close()
client.worker('sysconfig').importConfiguration(configuration=config)
