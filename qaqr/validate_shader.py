"""Compile exactly the supplied EFMI shader and verify its structured writes on WARP."""
import argparse
import ctypes as c
import pathlib
import json
import hashlib
import os
import sys
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--efmi-root',type=pathlib.Path,required=True)
parser.add_argument('--shader',type=pathlib.Path)
parser.add_argument('--compiler',type=pathlib.Path)
parser.add_argument('--out-bin',type=pathlib.Path)
args=parser.parse_args()
if sys.platform!='win32' or c.sizeof(c.c_void_p)!=8:
    parser.error('The WARP shader probe requires 64-bit Windows Python')
root=args.efmi_root.resolve()
shader=(args.shader or root/'Core/EFMI/Shaders/MergedSkeleton_InstanceConfigOverrider_ConstantBuffer.hlsl').resolve()
compiler_path=(args.compiler or root/'d3dcompiler_47.dll').resolve()
patched=shader.read_bytes()
output=args.out_bin.resolve() if args.out_bin else None
if output:
    if output.is_relative_to(root):
        parser.error('Write candidate bytecode outside the inspected EFMI root')
    if any(part.casefold() in {'mods','core','shadercache','shaderfixes'} for part in output.parts):
        parser.error('Use a separate compiled-output directory outside load trees')
    if output.exists():
        parser.error('Output already exists; use a fresh candidate filename')
P=c.c_void_p; U=c.c_uint; HRESULT=c.c_long
def check(hr, label):
    if hr<0: raise RuntimeError(label+' HRESULT='+hex(hr&0xffffffff))
def call(obj,idx,restype,args,*vals):
    vt=c.cast(obj,c.POINTER(c.POINTER(P))).contents
    return c.WINFUNCTYPE(restype,P,*args)(vt[idx])(obj,*vals)
def blob_bytes(obj):
    ptr=call(obj,3,P,[])
    size=call(obj,4,c.c_size_t,[])
    return c.string_at(ptr,size)
owned=[]
def release(obj):
    if obj and obj.value:call(obj,2,U,[])
compiler=c.WinDLL(str(compiler_path))
compile_fn=compiler.D3DCompile
compile_fn.argtypes=[P,c.c_size_t,c.c_char_p,P,P,c.c_char_p,c.c_char_p,U,U,c.POINTER(P),c.POINTER(P)]
compile_fn.restype=HRESULT
out=P();err=P();src=c.create_string_buffer(patched)
hr=compile_fn(src,len(patched),b'MergedSkeleton_InstanceConfigOverrider_ConstantBuffer.hlsl',None,None,b'main',b'cs_5_0',0x8000,0,c.byref(out),c.byref(err))
if err.value:
    print('compiler_messages',blob_bytes(err).decode(errors='replace'))
    release(err)
check(hr,'D3DCompile');code=blob_bytes(out);release(out)
dis=P();dis_fn=compiler.D3DDisassemble
dis_fn.argtypes=[P,c.c_size_t,U,c.c_char_p,c.POINTER(P)];dis_fn.restype=HRESULT
bytecode=c.create_string_buffer(code)
check(dis_fn(bytecode,len(code),0,None,c.byref(dis)),'D3DDisassemble')
assembly=blob_bytes(dis).decode(errors='replace');release(dis)
assert 'dcl_uav_structured u0, 16' in assembly
assert 'dcl_uav_typed' not in assembly
assert assembly.count('store_structured') == 4
class BufferDesc(c.Structure):
    _fields_=[(n,U) for n in ['ByteWidth','Usage','BindFlags','CPUAccessFlags','MiscFlags','StructureByteStride']]
class Initial(c.Structure):
    _fields_=[('pSysMem',P),('SysMemPitch',U),('SysMemSlicePitch',U)]
class Tex1DDesc(c.Structure):
    _fields_=[(n,U) for n in ['Width','MipLevels','ArraySize','Format','Usage','BindFlags','CPUAccessFlags','MiscFlags']]
class UAVDesc(c.Structure):
    _fields_=[('Format',U),('ViewDimension',U),('FirstElement',U),('NumElements',U),('Flags',U)]
class Mapped(c.Structure):
    _fields_=[('pData',P),('RowPitch',U),('DepthPitch',U)]
d3d=c.WinDLL(str(pathlib.Path(os.environ['SystemRoot'])/'System32/d3d11.dll'))
create=d3d.D3D11CreateDevice
create.argtypes=[P,U,P,U,c.POINTER(U),U,U,c.POINTER(P),c.POINTER(U),c.POINTER(P)]
create.restype=HRESULT
device=P();context=P();feature=U()
check(create(None,5,None,0,None,0,7,c.byref(device),c.byref(feature),c.byref(context)),'D3D11CreateDevice WARP')
owned += [device,context]
def buffer(desc,data=None):
    obj=P();init=None
    if data is not None:init=Initial(c.cast(data,P),0,0)
    check(call(device,3,HRESULT,[c.POINTER(BufferDesc),P,c.POINTER(P)],c.byref(desc),c.byref(init) if init else None,c.byref(obj)),'CreateBuffer')
    owned.append(obj);return obj
cs=P()
check(call(device,18,HRESULT,[P,c.c_size_t,P,c.POINTER(P)],bytecode,len(code),None,c.byref(cs)),'CreateComputeShader')
owned.append(cs)
cb_words=(U*64)(*[0x12340000+i for i in range(64)])
cb=buffer(BufferDesc(256,0,4,0,0,0),cb_words)
tex=P();ini=(c.c_float*4)(0,0,0,0);td=Tex1DDesc(1,1,1,2,0,8,0,0);init=Initial(c.cast(ini,P),0,0)
check(call(device,4,HRESULT,[c.POINTER(Tex1DDesc),P,c.POINTER(P)],c.byref(td),c.byref(init),c.byref(tex)),'CreateTexture1D')
owned.append(tex)
srv=P();check(call(device,7,HRESULT,[P,P,c.POINTER(P)],tex,None,c.byref(srv)),'CreateShaderResourceView')
owned.append(srv)
results=[]
try:
    for kind,misc in [('structured_source',0x40),('legacy_typed_source',0)]:
        initial_words=[0xABCD0000+i for i in range(128)]
        data=(U*128)(*initial_words)
        source=buffer(BufferDesc(512,0,0x88,0,misc,16),data)
        target=buffer(BufferDesc(512,0,0x88,0,0x40,16))
        call(context,47,None,[P,P],target,source)
        uv=P();ud=UAVDesc(0,1,0,32,0)
        check(call(device,8,HRESULT,[P,c.POINTER(UAVDesc),c.POINTER(P)],target,c.byref(ud),c.byref(uv)),'CreateUnorderedAccessView')
        owned.append(uv)
        call(context,71,None,[U,U,c.POINTER(P)],0,1,(P*1)(cb.value))
        call(context,67,None,[U,U,c.POINTER(P)],120,1,(P*1)(srv.value))
        call(context,68,None,[U,U,c.POINTER(P),P],0,1,(P*1)(uv.value),None)
        call(context,69,None,[P,P,U],cs,None,0)
        call(context,41,None,[U,U,U],1,1,1)
        call(context,68,None,[U,U,c.POINTER(P),P],0,1,(P*1)(None),None)
        readback=buffer(BufferDesc(512,3,0,0x20000,0,0))
        call(context,47,None,[P,P],readback,target)
        mapped=Mapped()
        check(call(context,14,HRESULT,[P,U,U,U,c.POINTER(Mapped)],readback,0,1,0,c.byref(mapped)),'Map readback')
        actual=list((U*128).from_address(mapped.pData))
        call(context,15,None,[P,U],readback,0)
        expected=list(cb_words)[:16]+initial_words[16:]
        assert actual == expected,(kind,'buffer words differ')
        results.append({'case':kind,'header_exact':True,'bone_payload_unchanged':True})
finally:
    for obj in reversed(owned):release(obj)
cache=shader.with_suffix('.cs_5_0.8000.bin')
assert shader.read_bytes()==patched,'Candidate HLSL changed during validation'
if output:
    output.parent.mkdir(parents=True,exist_ok=True)
    with output.open('xb') as handle:handle.write(code)
print(json.dumps({'compiler':'D3DCompile cs_5_0 flags=0x8000','shader':str(shader),'bytecode_sha256':hashlib.sha256(code).hexdigest(),'bytecode_bytes':len(code),'software_device':'WARP','feature_level':hex(feature.value),'structured_stride':16,'stores':4,'cases':results,'adjacent_cache_exists':cache.is_file(),'adjacent_cache_matches':cache.read_bytes()==code if cache.is_file() else None,'output':str(output) if output else None},ensure_ascii=False))
