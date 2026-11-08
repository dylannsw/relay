//! Encrypts refresh tokens at rest with Windows DPAPI, so only the signed-in
//! Windows user on this machine can decrypt them.

use crate::error::Result;

#[cfg(windows)]
mod imp {
    use crate::error::{msg, Result};
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    const ENTROPY: &[u8] = b"relay-mail-token-v1";

    fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        }
    }

    pub fn protect(data: &[u8]) -> Result<Vec<u8>> {
        run(data, true)
    }

    pub fn unprotect(data: &[u8]) -> Result<Vec<u8>> {
        run(data, false)
    }

    fn run(data: &[u8], encrypt: bool) -> Result<Vec<u8>> {
        let input = blob(data);
        let entropy = blob(ENTROPY);
        let mut out = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        // SAFETY: all pointers reference live buffers for the duration of the call;
        // the output buffer is allocated by Windows and released with LocalFree.
        unsafe {
            let ok = if encrypt {
                CryptProtectData(
                    &input,
                    std::ptr::null(),
                    &entropy,
                    std::ptr::null(),
                    std::ptr::null(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut out,
                )
            } else {
                CryptUnprotectData(
                    &input,
                    std::ptr::null_mut(),
                    &entropy,
                    std::ptr::null(),
                    std::ptr::null(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut out,
                )
            };
            if ok == 0 {
                return Err(msg(format!(
                    "Windows could not {} the stored token: {}",
                    if encrypt { "encrypt" } else { "decrypt" },
                    std::io::Error::last_os_error()
                )));
            }
            let bytes = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
            LocalFree(out.pbData as _);
            Ok(bytes)
        }
    }
}

#[cfg(not(windows))]
mod imp {
    // Relay targets Windows. On other platforms tokens are stored unencrypted
    // so the code still builds; replace with the OS keychain before shipping there.
    use crate::error::Result;
    pub fn protect(data: &[u8]) -> Result<Vec<u8>> {
        Ok(data.to_vec())
    }
    pub fn unprotect(data: &[u8]) -> Result<Vec<u8>> {
        Ok(data.to_vec())
    }
}

pub fn protect_str(s: &str) -> Result<Vec<u8>> {
    imp::protect(s.as_bytes())
}

pub fn unprotect_str(data: &[u8]) -> Result<String> {
    let bytes = imp::unprotect(data)?;
    String::from_utf8(bytes).map_err(|_| crate::error::msg("Stored token is corrupted"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn round_trip() {
        let enc = super::protect_str("refresh-token-123").unwrap();
        assert_ne!(enc, b"refresh-token-123");
        assert_eq!(super::unprotect_str(&enc).unwrap(), "refresh-token-123");
    }
}
