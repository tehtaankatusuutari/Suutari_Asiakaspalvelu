package fi.tehtaankatusuutari.asiakaspalvelu;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(StarPrinterPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
