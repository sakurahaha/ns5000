# Use case

The configuration worker is responsible for allowing system wide settings and system information. System wide implies setting of NEF itself but also various configuration options that can be set in the kernel or its drivers.

The configuration should allow to change specific NEF settings like MDP port etc.

Each configurable parameter in this should have getter and setter where schema validation is mandatory. 

It should show a tree of modules and their configuration options. Each parameter is defined as followed:

module.class.parameter
zfs.params.parameter
sd.override.parameter
qlc.mode.parameter
smbsrv.lmauth.parameter

First token is module name, remainder of the string is parameter name:

`smbsrv` is module name, `lmauth.parameter` is parameter name.

# Example

MDB allows to tweak `tgx_timeout`. If we change this through MDB, it is gone after a reboot. If wee supply boolean, persistent the setting should be written in /etc/system.

*Question: is it allowed to store persistent value in NEF database and just reapply it after reboot*

Certain config options should not be exposed through API when field hidden: true.

# API methods

* getModules() - returns a list of all registered classes
* getModuleParams(module) - return list of parameters registered with module
* get(module, [parameters])
* set(module, {param1: value1, param2: value2, ...}) 

# Binaries

* svcprop
* svcs
* svccfg
* prtconf/diag/lspci
* hba info's

# Cluster (not now)

The parameters should denote the impact on cluster:

* Must update cluster/parent
* may update, not required
* no impact

*What is this?*

# Database

Parameters can be volatile or not:

* volatile parameters are never stored neither in database nor in memory;
* non-volatile parameters are stored in memory (or database)

Non-volatile parameters themselves are static, that means they don't change without user interaction. When changing a parameter there should the option to make it persistent or not. Persistent values are stored in the database and they will be reapplied after sysconfig restart.

# Events

When a non-volatile configuration parameter is changed event is emitted:
```javascript
{
	type: 'config',
	module: <moduleId>,
	param: <paramName>,
	value: <paramValue>
}
```

#Modules

Sysconfig modules organize generic global OS settings in to centralized location.

-------------------------------------------------------------
##1 ZFS
-------------------------------------------------------------


1.1 get ::zfs_params

1.2 set ::zfs_params


-------------------------------------------------------------
##2 UNIX
-------------------------------------------------------------


2.1 get/set Hostname

2.2 get/set Domain name

2.3 get/set DNS 

2.4 get/set SMTP

-------------------------------------------------------------
##3 SysInfo
-------------------------------------------------------------


3.1 get CPU info

3.2 get mem info

3.3 get IRQ tables

3.4 get/set exclude kernel modules

3.5 get loaded kernel modules

3.6 get/set FC target/initiator kernel module

3.7 get lspci


-------------------------------------------------------------
##4 NEF
-------------------------------------------------------------


4.1 get/set Management IP

4.2 get/set Max replication jobs


-------------------------------------------------------------
##5 SMF
-------------------------------------------------------------


5.1 get SMF services states

5.2 get/set SMF service prop

-------------------------------------------------------------
##6 AD Domain
-------------------------------------------------------------

6.1 Join

6.2 get status

6.3 leave

-------------------------------------------------------------
##7 NFS server
-------------------------------------------------------------

7.1 get status

7.2 get property list

7.3 get/set individual properties

-------------------------------------------------------------
##8 SMB server
-------------------------------------------------------------

8.1 get status

8.2 get property list

8.3 get/set individual properties

-------------------------------------------------------------
##9 NTP client
-------------------------------------------------------------

9.1 get/set driftfile

9.2 get/set NTP servers

9.3 enable/disable NTP statistics

-------------------------------------------------------------
##10 SMTP configuration and default E-Mail addresses
-------------------------------------------------------------

10.1 get/set SMTP connection

10.2 get/set E-Mail default addresses


