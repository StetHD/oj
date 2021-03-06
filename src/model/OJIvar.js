/*
    OJIvar.js
    Simple model class for an instance variable
    (c) 2013-2015 musictheory.net, LLC
    MIT license, http://www.opensource.org/licenses/mit-license.php
*/

"use strict";


function OJIvar(name, className, type)
{
    this.name        = name;
    this.className   = className;
    this.type        = type;
    this.synthesized = false;
}


module.exports = OJIvar;
