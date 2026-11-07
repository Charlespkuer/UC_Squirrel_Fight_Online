// Return an app-scoped digest only. Never expose the native registry/OS value.
use serde::Serialize;
use sha2::{Digest, Sha256};

#[derive(Clone, Serialize)]
pub struct DeviceIdentity {
    id: String,
    platform: &'static str,
    provider: &'static str,
}

fn digest(platform: &str, value: &[u8]) -> String {
    let mut hash = Sha256::new();
    hash.update(b"com.ssdz.online\0");
    hash.update(platform.as_bytes());
    hash.update(b"\0");
    hash.update(value);
    format!("{:x}", hash.finalize())
}

#[cfg(target_os = "windows")]
pub fn read() -> Result<DeviceIdentity, String> {
    use winreg::{enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY}, RegKey};
    let key = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags("SOFTWARE\\Microsoft\\Cryptography", KEY_READ | KEY_WOW64_64KEY)
        .map_err(|_| "DEVICE_UNAVAILABLE: Windows device identity is unavailable")?;
    let raw: String = key.get_value("MachineGuid")
        .map_err(|_| "DEVICE_UNAVAILABLE: Windows device identity is unavailable")?;
    let normalized = raw.trim().to_ascii_lowercase();
    let digits = normalized.replace('-', "");
    if digits.len() != 32 || !digits.bytes().all(|b| b.is_ascii_hexdigit()) || digits.bytes().all(|b| b == b'0') {
        return Err("DEVICE_UNAVAILABLE: Windows device identity is invalid".into());
    }
    Ok(DeviceIdentity { id: digest("windows", normalized.as_bytes()), platform: "windows", provider: "machine-guid" })
}

#[cfg(target_os = "ios")]
pub fn read() -> Result<DeviceIdentity, String> {
    let bytes = keychain::read_or_create()?;
    Ok(DeviceIdentity { id: digest("ios", &bytes), platform: "ios", provider: "keychain" })
}

#[cfg(not(any(target_os = "windows", target_os = "ios")))]
pub fn read() -> Result<DeviceIdentity, String> {
    // Android exposes Settings.Secure.ANDROID_ID through SSDZAndroid, rather
    // than substituting an installation UUID in this Rust command.
    Err("DEVICE_UNAVAILABLE: use the native platform device bridge".into())
}

#[cfg(target_os = "ios")]
mod keychain {
    use std::{ffi::{c_char, c_void, CString}, ptr};
    type Ref = *const c_void;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFTypeDictionaryKeyCallBacks: c_void;
        static kCFTypeDictionaryValueCallBacks: c_void;
        static kCFBooleanTrue: Ref;
        static kCFBooleanFalse: Ref;
        fn CFDictionaryCreateMutable(allocator: Ref, capacity: isize, keys: Ref, values: Ref) -> *mut c_void;
        fn CFDictionarySetValue(dictionary: *mut c_void, key: Ref, value: Ref);
        fn CFStringCreateWithCString(allocator: Ref, text: *const c_char, encoding: u32) -> Ref;
        fn CFDataCreate(allocator: Ref, bytes: *const u8, length: isize) -> Ref;
        fn CFDataGetLength(data: Ref) -> isize;
        fn CFDataGetBytePtr(data: Ref) -> *const u8;
        fn CFGetTypeID(value: Ref) -> usize;
        fn CFDataGetTypeID() -> usize;
        fn CFRelease(value: Ref);
    }

    #[link(name = "Security", kind = "framework")]
    extern "C" {
        static kSecClass: Ref;
        static kSecClassGenericPassword: Ref;
        static kSecAttrService: Ref;
        static kSecAttrAccount: Ref;
        static kSecAttrSynchronizable: Ref;
        static kSecAttrAccessible: Ref;
        static kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly: Ref;
        static kSecReturnData: Ref;
        static kSecMatchLimit: Ref;
        static kSecMatchLimitOne: Ref;
        static kSecValueData: Ref;
        static kSecRandomDefault: Ref;
        fn SecItemCopyMatching(query: Ref, result: *mut Ref) -> i32;
        fn SecItemAdd(attributes: Ref, result: *mut Ref) -> i32;
        fn SecRandomCopyBytes(random: Ref, count: usize, bytes: *mut u8) -> i32;
    }

    struct Owned(Ref);
    impl Drop for Owned {
        fn drop(&mut self) { if !self.0.is_null() { unsafe { CFRelease(self.0); } } }
    }
    fn unavailable() -> String { "DEVICE_UNAVAILABLE: iOS Keychain device identity is unavailable".into() }

    unsafe fn base_query() -> Result<Owned, String> {
        let dictionary = CFDictionaryCreateMutable(ptr::null(), 0,
            ptr::addr_of!(kCFTypeDictionaryKeyCallBacks), ptr::addr_of!(kCFTypeDictionaryValueCallBacks));
        if dictionary.is_null() { return Err(unavailable()); }
        let owned = Owned(dictionary);
        CFDictionarySetValue(dictionary, kSecClass, kSecClassGenericPassword);
        CFDictionarySetValue(dictionary, kSecAttrSynchronizable, kCFBooleanFalse);
        for (key, text) in [(kSecAttrService, "com.ssdz.online.device"), (kSecAttrAccount, "stable-device-identity-v1")] {
            let text = CString::new(text).map_err(|_| unavailable())?;
            let value = Owned(CFStringCreateWithCString(ptr::null(), text.as_ptr(), 0x0800_0100));
            if value.0.is_null() { return Err(unavailable()); }
            CFDictionarySetValue(dictionary, key, value.0);
        }
        Ok(owned)
    }

    unsafe fn find() -> Result<Option<[u8; 32]>, String> {
        let query = base_query()?;
        CFDictionarySetValue(query.0 as *mut c_void, kSecReturnData, kCFBooleanTrue);
        CFDictionarySetValue(query.0 as *mut c_void, kSecMatchLimit, kSecMatchLimitOne);
        let mut result = ptr::null();
        let status = SecItemCopyMatching(query.0, &mut result);
        if status == -25300 { return Ok(None); } // errSecItemNotFound
        let data = Owned(result);
        if status != 0 || data.0.is_null() || CFGetTypeID(data.0) != CFDataGetTypeID() || CFDataGetLength(data.0) != 32 {
            return Err(unavailable());
        }
        let pointer = CFDataGetBytePtr(data.0);
        if pointer.is_null() { return Err(unavailable()); }
        let mut bytes = [0; 32];
        bytes.copy_from_slice(std::slice::from_raw_parts(pointer, 32));
        Ok(Some(bytes))
    }

    pub fn read_or_create() -> Result<[u8; 32], String> {
        unsafe {
            if let Some(existing) = find()? { return Ok(existing); }
            let mut bytes = [0; 32];
            if SecRandomCopyBytes(kSecRandomDefault, bytes.len(), bytes.as_mut_ptr()) != 0 { return Err(unavailable()); }
            let query = base_query()?;
            let data = Owned(CFDataCreate(ptr::null(), bytes.as_ptr(), bytes.len() as isize));
            if data.0.is_null() { return Err(unavailable()); }
            CFDictionarySetValue(query.0 as *mut c_void, kSecValueData, data.0);
            CFDictionarySetValue(query.0 as *mut c_void, kSecAttrAccessible, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly);
            let status = SecItemAdd(query.0, ptr::null_mut());
            if status == -25299 { return find()?.ok_or_else(unavailable); } // Concurrent creation; use the winner.
            if status != 0 { return Err(unavailable()); }
            Ok(bytes)
        }
    }
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    #[test]
    fn native_windows_identity_is_stable_and_opaque() {
        let a = super::read().expect("Windows device bridge must be available");
        let b = super::read().expect("Windows device bridge must remain available");
        assert!(a.id == b.id, "Native device identity must remain stable");
        assert_eq!(a.id.len(), 64);
        assert!(a.id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
        assert_eq!(a.platform, "windows");
        assert_eq!(a.provider, "machine-guid");
    }
}
