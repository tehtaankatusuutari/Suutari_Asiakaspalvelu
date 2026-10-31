package fi.tehtaankatusuutari.asiakaspalvelu;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothSocket;
import android.os.Build;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.IOException;
import java.io.OutputStream;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

// Classic Bluetooth (SPP) connection to Star printers. Star printers in Star Line
// mode accept raw bytes on the serial port profile, so no vendor SDK is needed.
@CapacitorPlugin(
    name = "StarPrinter",
    permissions = {
        @Permission(strings = { Manifest.permission.BLUETOOTH_CONNECT }, alias = "bluetooth")
    }
)
public class StarPrinterPlugin extends Plugin {
    private static final UUID SPP_UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");

    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private BluetoothSocket socket;
    private OutputStream out;
    private String connectedName;
    private String connectedAddress;

    private boolean hasBluetoothPermission() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.S
            || getPermissionState("bluetooth") == PermissionState.GRANTED;
    }

    @PluginMethod
    public void listPaired(PluginCall call) {
        if (!hasBluetoothPermission()) {
            requestPermissionForAlias("bluetooth", call, "permissionCallbackList");
            return;
        }
        resolvePaired(call);
    }

    @PermissionCallback
    private void permissionCallbackList(PluginCall call) {
        if (hasBluetoothPermission()) resolvePaired(call);
        else call.reject("Bluetooth-lupa puuttuu. Salli se asetuksista.");
    }

    private void resolvePaired(PluginCall call) {
        BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
        if (adapter == null || !adapter.isEnabled()) {
            call.reject("Bluetooth ei ole päällä");
            return;
        }
        try {
            JSArray devices = new JSArray();
            for (BluetoothDevice device : adapter.getBondedDevices()) {
                JSObject item = new JSObject();
                item.put("name", device.getName() == null ? "Tuntematon" : device.getName());
                item.put("address", device.getAddress());
                devices.put(item);
            }
            JSObject result = new JSObject();
            result.put("devices", devices);
            call.resolve(result);
        } catch (SecurityException e) {
            call.reject("Bluetooth-lupa puuttuu");
        }
    }

    @PluginMethod
    public void connect(PluginCall call) {
        String address = call.getString("address");
        if (address == null || address.isEmpty()) {
            call.reject("Tulostimen osoite puuttuu");
            return;
        }
        if (!hasBluetoothPermission()) {
            call.reject("Bluetooth-lupa puuttuu");
            return;
        }
        io.execute(() -> {
            closeQuietly();
            try {
                BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
                BluetoothDevice device = adapter.getRemoteDevice(address);
                BluetoothSocket s = connectSocket(device);
                socket = s;
                out = s.getOutputStream();
                connectedAddress = address;
                connectedName = device.getName() == null ? "Star-tulostin" : device.getName();
                JSObject result = new JSObject();
                result.put("name", connectedName);
                result.put("address", address);
                call.resolve(result);
            } catch (Exception e) {
                closeQuietly();
                call.reject("Yhteys tulostimeen epäonnistui (" + e.getClass().getSimpleName() + "): " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void print(PluginCall call) {
        String data = call.getString("data");
        if (data == null) {
            call.reject("Tulostettava data puuttuu");
            return;
        }
        byte[] bytes = Base64.decode(data, Base64.DEFAULT);
        io.execute(() -> {
            try {
                if (out == null) throw new IOException("Tulostin ei ole yhdistetty");
                out.write(bytes);
                out.flush();
                call.resolve();
            } catch (IOException e) {
                closeQuietly();
                call.reject("Tulostus epäonnistui: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        io.execute(() -> {
            closeQuietly();
            call.resolve();
        });
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject result = new JSObject();
        boolean connected = socket != null && socket.isConnected();
        result.put("connected", connected);
        result.put("name", connected ? connectedName : "");
        result.put("address", connected ? connectedAddress : "");
        call.resolve(result);
    }

    // Some Star printers don't advertise the SPP service record, and some need an
    // unsecured link; try the standard secure socket first, then the fallbacks.
    private BluetoothSocket connectSocket(BluetoothDevice device) throws Exception {
        IOException last = null;
        try {
            BluetoothSocket s = device.createRfcommSocketToServiceRecord(SPP_UUID);
            s.connect();
            return s;
        } catch (IOException e) {
            last = e;
        }
        try {
            BluetoothSocket s = device.createInsecureRfcommSocketToServiceRecord(SPP_UUID);
            s.connect();
            return s;
        } catch (IOException e) {
            last = e;
        }
        try {
            java.lang.reflect.Method m = device.getClass().getMethod("createRfcommSocket", int.class);
            BluetoothSocket s = (BluetoothSocket) m.invoke(device, 1);
            s.connect();
            return s;
        } catch (Exception e) {
            if (last != null) throw last;
            throw e;
        }
    }

    private void closeQuietly() {
        try { if (out != null) out.close(); } catch (IOException ignored) { }
        try { if (socket != null) socket.close(); } catch (IOException ignored) { }
        out = null;
        socket = null;
        connectedName = null;
        connectedAddress = null;
    }
}
