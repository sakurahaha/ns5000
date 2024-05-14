#!/usr/bin/python
import sys
sys.path.append('../../../extlib/python')

import nef
client = nef.NEFClient('tcp://127.0.0.1:5557')
config = client.worker('sysconfig').exportConfiguration()

if len(sys.argv) == 1:
    print(config)
else:
    f = open(sys.argv[1], 'w')
    f.write(config)
    f.close()

